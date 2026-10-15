// Carryovers in / used / out, basis by year, and the prior preparer's file vs this return.

import type { ViewCell, ViewDto, ViewFlag, ViewRow } from '@easetax/shared';
import { lineId } from '@easetax/shared';
import { compact, fmt, money, n, text, type ViewCtx } from './ctx.ts';

const OUT_ALIAS: Record<string, string> = { amt_credit: 'minimum_tax_credit_from_2025_amt' };

export interface CarryAgreement {
  key: string;
  nodeId: string;
  value: number;
  prior: number;
  agreed: boolean;
  verified: boolean;
  sources: string[];
}

/** Every line that carries a prior-year amount in, agreed to the prior-year record. */
export function carryoverAgreement(ctx: ViewCtx): CarryAgreement[] {
  const verified = ctx.verifiedNodes();
  return ctx.wp.b
    .version(ctx.v)!
    .lines.filter((l) => l.rule === 'R-PRIOR-YEAR-CARRY')
    .map((l) => {
      const pys = l.sources.filter((s) => s.startsWith('py:'));
      const prior = pys.reduce((s, p) => s + Math.abs(n(ctx.wp.rawValue(p))), 0);
      const c = ctx.cell(l.key)!;
      return { key: l.key, nodeId: c.nodeId!, value: n(c.value), prior, agreed: Math.abs(Math.abs(n(c.value)) - prior) < 0.5, verified: verified.has(c.nodeId!), sources: pys };
    });
}

export function carryovers(ctx: ViewCtx): ViewDto {
  const ver = ctx.wp.b.version(ctx.v)!;
  const cin = (ctx.packet.prior_years.carryovers_into_2025 ?? {}) as Record<string, any>;
  const cout = (ver.carryovers_out ?? {}) as Record<string, any>;
  const findings: ViewFlag[] = [];
  const sections = [];
  for (const jur of ['federal', 'california'] as const) {
    const inObj: Record<string, unknown> = jur === 'federal' ? cin : (cin.california ?? {});
    const base = jur === 'federal' ? '/carryovers_into_2025' : '/carryovers_into_2025/california';
    const outObj: Record<string, unknown> = cout[jur] ?? {};
    const keys = [...new Set([...Object.keys(inObj).filter((k) => typeof inObj[k] === 'number'), ...Object.keys(outObj).filter((k) => typeof outObj[k] === 'number')])];
    const covered = new Set<string>();
    const rows: ViewRow[] = [];
    for (const k of keys) {
      if (covered.has(k)) continue;
      const outKey = k in outObj ? k : OUT_ALIAS[k];
      if (outKey) covered.add(outKey);
      covered.add(k);
      const ptr = `${base}/${k}`;
      const used = typeof inObj[k] === 'number' ? ctx.linesCiting(`py:${ptr}`) : [];
      const inCell: ViewCell | undefined = typeof inObj[k] === 'number' ? ctx.py(ptr) : undefined;
      rows.push({
        id: `${jur}:${k}`,
        label: k.replace(/_/g, ' '),
        sublabel: used.length ? `used on ${used.join(', ')}` : inCell && n(inCell.value) ? 'not cited by any 2025 line' : undefined,
        nodeId: inCell?.nodeId ?? (used[0] && lineId(ctx.v, used[0])),
        cells: {
          in: inCell,
          used: used[0] ? ctx.cell(used[0]) : undefined,
          out: outKey !== undefined && typeof outObj[outKey] === 'number' ? { value: outObj[outKey], note: `carryovers_out.${jur}.${outKey}` } : undefined,
        },
        links: used.map((u) => lineId(ctx.v, u)),
        flags: inCell && n(inCell.value) && !used.length && jur === 'federal' ? [{ code: 'CARRYOVER_NOT_USED', severity: 'info', text: 'Carryover in is not cited by any 2025 line' }] : undefined,
      });
    }
    for (const [k, v] of Object.entries(outObj)) {
      if (covered.has(k) || typeof v === 'number') continue;
      for (const [sub, amt] of Object.entries(v as Record<string, number>))
        rows.push({ id: `${jur}:${k}:${sub}`, label: `${k.replace(/_/g, ' ')}: ${sub}`, nodeId: `asset:${ctx.v}:${sub}`, cells: { out: { value: amt, nodeId: `asset:${ctx.v}:${sub}` } } });
    }
    sections.push({ id: jur, title: jur === 'federal' ? 'Federal' : 'California', columns: [money('in', 'In from 2024'), money('used', '2025 line (effective)'), money('out', 'Out to 2026')], rows });
  }
  const agree = carryoverAgreement(ctx);
  const agreeRows: ViewRow[] = agree.map((a) => {
    const flags: ViewFlag[] = [];
    if (!a.agreed) flags.push({ code: 'CARRYOVER_MISMATCH', severity: 'error', text: `Line ${fmt(a.value)} vs prior-year record ${fmt(a.prior)}`, nodeIds: [a.nodeId, ...a.sources] });
    findings.push(...flags);
    return {
      id: a.key,
      label: ctx.line(a.key)!.label,
      sublabel: a.sources.join(', '),
      nodeId: a.nodeId,
      status: !a.agreed ? 'mismatch' : a.verified ? 'agreed and verified' : 'agrees (not yet verified)',
      cells: { line: ctx.cell(a.key), prior: { value: a.prior, nodeId: a.sources[0] } },
      flags: flags.length ? flags : undefined,
    };
  });
  const sep = n(cout.federal?.sep_contribution_not_deductible_for_2025);
  if (sep) findings.push({ code: 'SEP_EXCESS', severity: 'warning', text: `SEP contribution ${fmt(sep)} over the 2025 limit carried out (excess contributions are subject to a 6% excise tax unless withdrawn)`, nodeIds: compact([ctx.cell('Sch1.16')?.nodeId]) });
  sections.push({ id: 'agreement', title: 'Carryovers in agreed to the prior-year record', columns: [money('line', '2025 line'), money('prior', '2024 record')], rows: agreeRows });
  return ctx.view('carryovers', 'Carryovers', 'Carryovers in from 2024 (prior return and prior preparer), what 2025 used, and what carries out to 2026.', sections, findings);
}

// ---------------------------------------------------------------- basis

export function basis(ctx: ViewCtx): ViewDto {
  const br = (ctx.packet.prior_years.basis_records ?? {}) as Record<string, any[]>;
  const findings: ViewFlag[] = [];
  const sections = [];

  // S corporation stock basis, rolled independently through any K-1 that fills a gap.
  const scorpKey = Object.keys(br).find((k) => k.startsWith('scorp_'));
  if (scorpKey) {
    const rows: ViewRow[] = [];
    let running: number | null = null;
    br[scorpKey]!.forEach((r, i) => {
      const ptr = `/basis_records/${scorpKey}/${i}`;
      const flags: ViewFlag[] = [];
      let income = r.k1_income ?? null;
      let dist = r.distributions ?? null;
      let incomeNode: string | undefined = r.k1_income != null ? `py:${ptr}/k1_income` : undefined;
      let distNode: string | undefined = r.distributions != null ? `py:${ptr}/distributions` : undefined;
      if (income === null && r.ending_stock_basis == null) {
        const k1 = ctx.docsOfType('K-1-1120S').find((d) => d.tax_year === r.year);
        if (k1) {
          const b1 = ctx.docEv(k1.id, 'box1');
          const b4 = ctx.docEv(k1.id, 'box4');
          const d16 = ctx.docEv(k1.id, 'box16d');
          income = n(b1?.value) + n(b4?.value);
          dist = n(d16?.value);
          incomeNode = b1 && `ev:${b1.id}`;
          distNode = d16 && `ev:${d16.id}`;
          flags.push({ code: 'BASIS_GAP_FILLED', severity: 'info', text: `${r.year} gap in the prior file filled from the ${r.year} K-1 (${k1.id}, received ${k1.received_at.slice(0, 10)})`, nodeIds: [`doc:${k1.id}`] });
        } else flags.push({ code: 'BASIS_GAP', severity: 'warning', text: `No ${r.year} basis and no ${r.year} K-1 in file`, nodeIds: [`py:${ptr}`] });
      }
      let computed: number | null = null;
      if (r.ending_stock_basis != null) computed = r.ending_stock_basis;
      else if (running !== null && income !== null) computed = Math.max(0, running + n(income) - n(dist));
      if (r.ending_stock_basis == null && r.year === 2024 && computed !== null)
        flags.push({ code: 'BASIS_NOT_ROLLED', severity: 'info', text: `Prior preparer did not roll basis ("assumed basis sufficient"); recomputed ${fmt(computed)}`, nodeIds: [`py:${ptr}`] });
      rows.push({
        id: `scorp-${r.year}`,
        label: String(r.year),
        sublabel: r.source,
        nodeId: `py:${ptr}`,
        cells: { income: { value: income, nodeId: incomeNode }, distributions: { value: dist, nodeId: distNode }, recorded: { value: r.ending_stock_basis ?? null, nodeId: `py:${ptr}` }, computed: { value: computed } },
        flags: flags.length ? flags : undefined,
      });
      running = computed;
    });
    const begin = ctx.cell('F7203.1');
    if (begin) {
      const flags: ViewFlag[] = running !== null && Math.abs(n(begin.value) - running) > 1 ? [{ code: 'BASIS_ROLL', severity: 'error', text: `Recomputed 2024 ending basis ${fmt(running)} vs Form 7203 line 1 ${fmt(n(begin.value))}`, nodeIds: [begin.nodeId!] }] : [];
      findings.push(...flags);
      rows.push({
        id: 'scorp-2025',
        label: '2025 (Form 7203)',
        nodeId: begin.nodeId,
        cells: { begin, income: ctx.cell('F7203.4'), distributions: ctx.cell('F7203.6'), computed: ctx.cell('F7203.15'), excess: ctx.cell('F7203.excess') },
        flags: flags.length ? flags : undefined,
      });
      const excess = ctx.num('F7203.excess');
      if (excess) findings.push({ code: 'EXCESS_DISTRIBUTIONS', severity: 'warning', text: `Distributions exceed stock basis by ${fmt(excess)}: taxed as capital gain`, nodeIds: compact([ctx.cell('F7203.excess')?.nodeId]) });
    }
    sections.push({ id: 'scorp', title: 'S corporation stock basis', columns: [money('begin', 'Beginning'), money('income', 'Income items'), money('distributions', 'Distributions'), money('recorded', 'Recorded ending'), money('computed', 'Computed ending'), money('excess', 'Excess distributions')], rows });
  }

  // Partnership capital and outside basis.
  const pKey = Object.keys(br).find((k) => k.startsWith('partnership_'));
  if (pKey) {
    const rows: ViewRow[] = br[pKey]!.map((r, i) => {
      const ptr = `/basis_records/${pKey}/${i}`;
      const flags: ViewFlag[] = r.outside_basis == null ? [{ code: 'OUTSIDE_BASIS_MISSING', severity: 'warning', text: `Outside basis never computed (${r.source})`, nodeIds: [`py:${ptr}`] }] : [];
      findings.push(...flags);
      return { id: `p-${r.year}`, label: String(r.year), sublabel: r.source, nodeId: `py:${ptr}`, cells: { capital: { value: r.ending_capital_account, nodeId: `py:${ptr}/ending_capital_account` }, outside: { value: r.outside_basis, nodeId: `py:${ptr}` } }, flags: flags.length ? flags : undefined };
    });
    const k1 = ctx.docsOfType('K-1-1065').find((d) => d.tax_year === ctx.packet.household.tax_year);
    if (k1) {
      const ev = (f: string) => ctx.docEv(k1.id, f);
      const begin = ev('cap_begin');
      const end = ev('cap_end');
      const plus = ['box1', 'box2', 'box5', 'box6a', 'box9a'].reduce((s, f) => s + n(ev(f)?.value), 0);
      const minus = ['box19a', 'box21'].reduce((s, f) => s + n(ev(f)?.value), 0);
      const computed = n(begin?.value) + plus - minus;
      const flags: ViewFlag[] = end && Math.abs(computed - n(end.value)) > 1 ? [{ code: 'CAPITAL_ROLL', severity: 'info', text: `Begin + income − distributions − foreign tax = ${fmt(computed)}; K-1 ending capital ${fmt(n(end.value))}`, nodeIds: [`ev:${end.id}`] }] : [];
      rows.push({ id: 'p-2025', label: `${ctx.packet.household.tax_year} (K-1 ${k1.id})`, nodeId: end && `ev:${end.id}`, cells: { begin: begin && ctx.ev(begin.id), capital: end && ctx.ev(end.id), computed: { value: computed }, outside: { value: null } }, flags: flags.length ? flags : undefined });
    }
    sections.push({ id: 'partnership', title: 'Partnership capital and outside basis', columns: [money('begin', 'Beginning capital'), money('capital', 'Ending capital'), money('computed', 'Recomputed ending'), money('outside', 'Outside basis')], rows });
  }

  // IRA nondeductible basis.
  const iraKey = Object.keys(br).find((k) => k.startsWith('ira_'));
  if (iraKey) {
    const rows: ViewRow[] = br[iraKey]!.map((r, i) => ({ id: `ira-${r.year}`, label: String(r.year), sublabel: r.source, nodeId: `py:/basis_records/${iraKey}/${i}`, cells: { basis: { value: r.form_8606_line_14, nodeId: `py:/basis_records/${iraKey}/${i}` } } }));
    for (const k of ['F8606.2', 'F8606.1', 'F8606.14']) {
      const c = ctx.cell(k);
      if (c) rows.push({ id: k, label: ctx.line(k)!.label, nodeId: c.nodeId, cells: { basis: c } });
    }
    const qa = ctx.packet.client.questionnaire.find((q) => /IRA/i.test(q.question) && /basis/i.test(q.question + q.answer));
    if (qa && /none|no prior|don't|do not/i.test(qa.answer) && ctx.num('F8606.2') > 0) {
      const f: ViewFlag = { code: 'CLIENT_VS_RECORD', severity: 'warning', text: `Client says no prior IRA basis (${qa.id}); the 2024 Form 8606 shows ${fmt(ctx.num('F8606.2'))}, which the return uses`, nodeIds: [`qa:${qa.id}`, lineId(ctx.v, 'F8606.2')] };
      findings.push(f);
      rows[0]!.flags = [f];
    }
    sections.push({ id: 'ira', title: 'IRA nondeductible basis (Form 8606)', columns: [money('basis', 'Basis')], rows });
  }

  // Anything else (e.g. home cost).
  for (const [k, list] of Object.entries(br)) {
    if ([scorpKey, pKey, iraKey].includes(k)) continue;
    sections.push({
      id: k,
      title: k.replace(/_/g, ' '),
      columns: [money('amount', 'Amount'), text('event', 'Event')],
      rows: list.map((r, i) => ({ id: `${k}-${i}`, label: r.event ?? String(r.year ?? i), sublabel: r.source, nodeId: `py:/basis_records/${k}/${i}`, cells: { amount: { value: r.price ?? r.amount ?? null, nodeId: `py:/basis_records/${k}/${i}` }, event: { value: r.event ?? '' } } })),
    });
  }
  return ctx.view('basis', 'Basis by year', 'S corporation stock basis, partnership capital and outside basis, IRA basis and home cost, year by year, with gaps called out and rolled forward independently.', sections, findings);
}

// ---------------------------------------------------------------- prior preparer vs us

interface Topic {
  re: RegExp;
  nodes: (ctx: ViewCtx) => string[];
  resolvedBy?: (ctx: ViewCtx) => string | undefined;
}

const TOPICS: Topic[] = [
  {
    re: /Woodworks|S corp basis|2023 K-1/i,
    nodes: (c) => compact([c.cell('F7203.1')?.nodeId, c.cell('F7203.excess')?.nodeId, ...c.docsOfType('K-1-1120S').filter((d) => d.tax_year < c.packet.household.tax_year).map((d) => `doc:${d.id}`)]),
    resolvedBy: (c) => {
      const d = c.docsOfType('K-1-1120S').find((x) => x.tax_year < c.packet.household.tax_year);
      return d ? `${d.tax_year} K-1 now in file (${d.id}); basis rolled to ${fmt(c.num('F7203.1'))} (Form 7203 line 1)` : undefined;
    },
  },
  {
    re: /8606|5498|IRA basis/i,
    nodes: (c) => compact([c.cell('F8606.2')?.nodeId, ...c.docsOfType('5498').map((d) => `doc:${d.id}`)]),
    resolvedBy: (c) => {
      const d = c.docsOfType('5498');
      return d.length ? `Forms 5498 in file (${d.map((x) => `${x.id} ${x.tax_year}`).join(', ')}); return uses basis ${fmt(c.num('F8606.2'))}` : undefined;
    },
  },
  { re: /Sparbanken|FBAR|8938/i, nodes: (c) => compact(['F8938.1.max', 'F8938.req', 'SchB.7a'].map((k) => c.cell(k)?.nodeId)) },
  { re: /appliances|bonus/i, nodes: (c) => compact([`asset:${c.v}:SAC-APPL`, c.cell('FTB3885A.SAC-APPL')?.nodeId]) },
  {
    re: /home office|square footage/i,
    nodes: (c) => compact([c.cell('SchC.30')?.nodeId, ...c.docsOfType('client_note').map((d) => `doc:${d.id}`)]),
    resolvedBy: (c) => (c.has('SchC.30') ? `Return uses ${c.line('SchC.30')!.label} = ${fmt(c.num('SchC.30'))}` : undefined),
  },
  { re: /3520|inheritance/i, nodes: (c) => compact([c.cell('SchB.8')?.nodeId, ...c.docsOfType('foreign_bank_statement').map((d) => `doc:${d.id}`)]) },
];

export function priorPreparer(ctx: ViewCtx): ViewDto {
  const ppw = (ctx.packet.prior_years.prior_preparer_workpaper ?? {}) as { summary_memo?: string; notes?: string[]; open_items_left_by_prior_preparer?: string[]; source_document?: string };
  const findings: ViewFlag[] = [];
  const mk = (kind: 'note' | 'open_item', textv: string, i: number): ViewRow => {
    const ptr = `/prior_preparer_workpaper/${kind === 'note' ? 'notes' : 'open_items_left_by_prior_preparer'}/${i}`;
    const topic = TOPICS.find((t) => t.re.test(textv));
    const nodes = topic ? topic.nodes(ctx).filter((id) => ctx.wp.g.nodes.has(id) || id.startsWith('line:') || id.startsWith('doc:')) : [];
    const judgments = ctx.judgmentsOn(nodes);
    const adjustments = ctx.adjustmentsOn(nodes).filter((a) => a.status === 'approved' || a.status === 'proposed');
    const verified = nodes.filter((nid) => ctx.verifiedNodes().has(nid));
    const data = topic?.resolvedBy?.(ctx);
    const st = judgments.length || adjustments.length || verified.length ? 'addressed in workpaper' : data ? 'data now in file (not yet reviewed)' : kind === 'open_item' ? 'open' : 'carried forward';
    const firstLine = nodes.find((x) => x.startsWith('line:'));
    const flags: ViewFlag[] = kind === 'open_item' && st === 'open' ? [{ code: 'PRIOR_OPEN_ITEM', severity: 'warning', text: `Prior preparer open item unresolved: ${textv}`, nodeIds: [`py:${ptr}`, ...nodes] }] : [];
    findings.push(...flags);
    return {
      id: `${kind}-${i}`,
      label: textv,
      sublabel: kind === 'note' ? 'Prior preparer note' : 'Open item left by prior preparer',
      nodeId: `py:${ptr}`,
      status: st,
      cells: {
        thisReturn: firstLine ? ctx.cell(firstLine.split(':')[2]!) : undefined,
        what: { value: [data, ...judgments.map((j) => `Judgment: ${j.topic} → ${j.decision} (${j.authority})`), ...adjustments.map((a) => `Adjustment ${a.status}: ${a.reason}`), verified.length ? `Verified: ${verified.join(', ')}` : ''].filter(Boolean).join(' · ') },
      },
      links: nodes,
      flags: flags.length ? flags : undefined,
    };
  };
  const cols = [money('thisReturn', 'This return (effective)'), text('what', 'What this return does')];
  return ctx.view(
    'prior-preparer',
    'Prior preparer vs us',
    `The prior preparer's 2024 notes and open items (${ppw.source_document ?? 'prior workpaper'}) against what this return does, linked to judgments, adjustments and verifications.`,
    [
      { id: 'memo', title: 'Prior preparer summary memo', columns: [text('text', 'Memo')], rows: [{ id: 'memo', label: ppw.summary_memo ?? '', nodeId: 'py:/prior_preparer_workpaper/summary_memo', cells: {} }] },
      { id: 'open-items', title: 'Open items left by the prior preparer', columns: cols, rows: (ppw.open_items_left_by_prior_preparer ?? []).map((t, i) => mk('open_item', t, i)) },
      { id: 'notes', title: 'Prior preparer notes', columns: cols, rows: (ppw.notes ?? []).map((t, i) => mk('note', t, i)) },
    ],
    findings,
  );
}
