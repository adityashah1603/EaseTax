// Sales detail (Form 8949): ~295 lots summarized by box × term × broker, exceptions first
// (design §7.6). Lot line values are the gain in dollars to the cent; proceeds, basis and
// adjustments are parsed from the engine's lot label and cross-checked against the value.

import type { ViewDto, ViewFlag, ViewRow } from '@easetax/shared';
import { lineId } from '@easetax/shared';
import { fmt, money, n, round2, text, type ViewCtx } from './ctx.ts';

const SHORT_BOXES = new Set(['A', 'B', 'C', 'G', 'H', 'I']);
const LABEL_RE = /^(.*) \(acquired ([^,]+), sold ([^;]+); proceeds (-?[\d,.]+), basis (-?[\d,.]+)(?:, adjustment ([A-Z]) (-?[\d,.]+))?\)$/;
const num = (s: string | undefined) => (s === undefined ? 0 : Number(s.replace(/,/g, '')));

export interface Lot {
  key: string;
  box: string;
  lot: string;
  term: 'short' | 'long';
  broker: string;
  brokerDoc?: string;
  description: string;
  acquired: string;
  sold: string;
  proceeds: number;
  basis: number;
  adjCode?: string;
  adjAmount: number;
  engineGain: number;
  gain: number;
  adjusted: boolean;
  sources: string[];
  flags: ViewFlag[];
  /** Lower sorts first; Infinity = no exception. */
  priority: number;
}

const PRIORITY: Record<string, number> = {
  ZERO_BASIS: 0,
  MISSING_BASIS: 0,
  WASH_SALE: 2,
  SUMMARY_DETAIL: 3,
  SUPERSEDED_SOURCE: 4,
  CHANGED_BETWEEN_VERSIONS: 5,
  ADJUSTED: 6,
  LOW_CONFIDENCE: 1,
  LABEL_MATH: 3,
};

export function lots(ctx: ViewCtx): Lot[] {
  const b = ctx.wp.b;
  const ver = b.version(ctx.v)!;
  const superseded = new Set(ver.documents_superseded as string[]);
  // Lot keys changed by any engine run up to the current version.
  const changes = new Map<string, string[]>();
  for (const v of b.versions) {
    if (v.computed_at > ver.computed_at) continue;
    for (const c of v.changes_from_previous) {
      if (!c.key.startsWith('F8949.') || c.key.endsWith('.total')) continue;
      const lotId = c.key.split('.')[2]!;
      const removed = v.changes_from_previous.find((x) => x.change === 'removed' && x.key !== c.key && x.key.endsWith(`.${lotId}`));
      const txt =
        c.change === 'added' && removed
          ? `moved from ${removed.key} in ${v.version} (gain ${fmt(n(c.new))})`
          : c.change === 'added'
            ? `added in ${v.version}`
            : c.change === 'removed'
              ? `removed in ${v.version}`
              : `changed in ${v.version}: ${fmt(n(c.old))} → ${fmt(n(c.new))}`;
      const list = changes.get(c.key) ?? [];
      list.push(txt);
      changes.set(c.key, list);
    }
  }
  // Supplemental adjusted basis (e.g. stock plan statement) keyed by acquisition date.
  const suppBasis = new Map<string, { evId: string; basis: number }>();
  for (const d of ctx.docsOfType('stock_plan_supplement')) {
    for (const e of ctx.docEvs(d.id)) {
      const m = /^(.*)_adjusted_basis$/.exec(e.field);
      if (!m) continue;
      const acq = ctx.docEv(d.id, `${m[1]}_acquired`);
      if (acq) suppBasis.set(String(acq.value), { evId: e.id, basis: n(e.value) });
    }
  }

  const out: Lot[] = [];
  for (const l of ver.lines) {
    if (l.form !== 'F8949' || l.line.endsWith('total')) continue;
    const [box, lot] = l.line.split('.') as [string, string];
    const m = LABEL_RE.exec(l.label);
    const c = ctx.cell(l.key)!;
    const evs = l.sources.map((s) => b.evs.get(s)).filter((e) => !!e);
    const doc = evs[0] ? b.docs.get(evs[0].document_id) : undefined;
    const lotRec: Lot = {
      key: l.key,
      box,
      lot,
      term: SHORT_BOXES.has(box) ? 'short' : 'long',
      broker: doc?.issuer ?? (l.inputs.length ? `Derived (${l.inputs.join(', ')})` : 'Unknown'),
      brokerDoc: doc?.id,
      description: m?.[1] ?? l.label,
      acquired: m?.[2] ?? '',
      sold: m?.[3] ?? '',
      proceeds: num(m?.[4]),
      basis: num(m?.[5]),
      adjCode: m?.[6],
      adjAmount: num(m?.[7]),
      engineGain: n(l.value),
      gain: n(c.value),
      adjusted: !!c.adjusted,
      sources: l.sources,
      flags: [],
      priority: Infinity,
    };
    const f = lotRec.flags;
    const id = lineId(ctx.v, l.key);
    // A lot derived from other lines (e.g. S corp excess distributions) has no broker basis.
    if (!l.inputs.length) {
      if (!m) f.push({ code: 'MISSING_BASIS', severity: 'warning', text: 'Basis not reported on the lot', nodeIds: [id] });
      else if (lotRec.basis === 0 && lotRec.proceeds > 0) {
        const s = suppBasis.get(lotRec.acquired);
        f.push({
          code: 'ZERO_BASIS',
          severity: 'error',
          text: s
            ? `Zero basis; supplemental statement shows adjusted basis ${fmt(s.basis)} (gain overstated ≈ ${fmt(s.basis)})`
            : 'Zero basis used for a sale with proceeds',
          nodeIds: s ? [id, `ev:${s.evId}`] : [id],
        });
      }
    }
    if (lotRec.adjCode === 'W') f.push({ code: 'WASH_SALE', severity: 'info', text: `Wash sale loss disallowed ${fmt(lotRec.adjAmount)}`, nodeIds: [id] });
    else if (lotRec.adjCode) f.push({ code: 'ADJUSTED', severity: 'info', text: `Adjustment code ${lotRec.adjCode} ${fmt(lotRec.adjAmount)}`, nodeIds: [id] });
    if (c.adjusted) f.push({ code: 'ADJUSTED', severity: 'info', text: `Workpaper adjustment: ${fmt(lotRec.engineGain)} → ${fmt(lotRec.gain)}`, nodeIds: [id] });
    if (m && Math.abs(round2(lotRec.proceeds - lotRec.basis + lotRec.adjAmount) - lotRec.engineGain) > 0.01)
      f.push({ code: 'LABEL_MATH', severity: 'warning', text: `Proceeds − basis + adjustment ≠ gain (${fmt(round2(lotRec.proceeds - lotRec.basis + lotRec.adjAmount))} vs ${fmt(lotRec.engineGain)})`, nodeIds: [id] });
    const sup = evs.filter((e) => superseded.has(e.document_id));
    if (sup.length) f.push({ code: 'SUPERSEDED_SOURCE', severity: 'warning', text: `Sourced from superseded document ${sup[0]!.document_id}`, nodeIds: [id, ...sup.map((e) => `ev:${e.id}`)] });
    for (const t of changes.get(l.key) ?? []) f.push({ code: 'CHANGED_BETWEEN_VERSIONS', severity: 'info', text: t, nodeIds: [id] });
    const low = evs.filter((e) => e.confidence < 0.9);
    if (low.length) f.push({ code: 'LOW_CONFIDENCE', severity: 'warning', text: `Low-confidence read (${low.map((e) => `${e.field} ${e.confidence}`).join(', ')})`, nodeIds: low.map((e) => `ev:${e.id}`) });
    lotRec.priority = Math.min(Infinity, ...f.map((x) => PRIORITY[x.code] ?? 9));
    out.push(lotRec);
  }
  return out.sort((a, b) => a.priority - b.priority || Math.abs(b.gain) - Math.abs(a.gain) || a.key.localeCompare(b.key, 'en', { numeric: true }));
}

function lotRow(ctx: ViewCtx, l: Lot): ViewRow {
  const c = ctx.cell(l.key)!;
  return {
    id: l.key,
    label: l.description,
    sublabel: `Box ${l.box} · ${l.term}-term · ${l.broker} · acquired ${l.acquired}, sold ${l.sold}`,
    nodeId: c.nodeId,
    cells: {
      proceeds: { value: l.proceeds, nodeId: c.nodeId },
      basis: { value: l.basis, nodeId: c.nodeId },
      adjustment: { value: l.adjAmount, note: l.adjCode },
      gain: c,
    },
    flags: l.flags.length ? l.flags : undefined,
    links: l.sources.map((s) => `ev:${s}`),
  };
}

export function sales(ctx: ViewCtx): ViewDto {
  const all = lots(ctx);
  const exceptions = all.filter((l) => l.flags.length);
  const cols = [money('proceeds', 'Proceeds'), money('basis', 'Basis'), money('adjustment', 'Adjustment'), money('gain', 'Gain (loss)')];

  // Groups: box × term × broker.
  const groups = new Map<string, Lot[]>();
  for (const l of all) {
    const k = `${l.box}|${l.term}|${l.broker}`;
    groups.set(k, [...(groups.get(k) ?? []), l]);
  }
  const groupRows: ViewRow[] = [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, ls]) => {
      const [box, term, broker] = k.split('|');
      const total = ctx.cell(`F8949.${box}.total`);
      const gain = round2(ls.reduce((s, l) => s + l.gain, 0));
      return {
        id: k,
        label: `Box ${box} · ${term}-term · ${broker}`,
        sublabel: `${ls.length} lot(s), ${ls.filter((l) => l.flags.length).length} exception(s)`,
        nodeId: total?.nodeId,
        cells: {
          count: { value: ls.length },
          proceeds: { value: round2(ls.reduce((s, l) => s + l.proceeds, 0)) },
          basis: { value: round2(ls.reduce((s, l) => s + l.basis, 0)) },
          adjustment: { value: round2(ls.reduce((s, l) => s + l.adjAmount, 0)) },
          gain: { value: gain },
        },
      };
    });
  const boxTotals: ViewRow[] = [...new Set(all.map((l) => l.box))].sort().map((box) => {
    const ls = all.filter((l) => l.box === box);
    const total = ctx.cell(`F8949.${box}.total`);
    const sum = round2(ls.reduce((s, l) => s + l.gain, 0));
    const flags: ViewFlag[] = [];
    if (total && Math.abs(Math.round(sum) - n(total.value)) > 1)
      flags.push({ code: 'BOX_TOTAL_MISMATCH', severity: 'warning', text: `Lots sum to ${fmt(sum)}; box total line is ${fmt(n(total.value))}`, nodeIds: [total.nodeId!] });
    return { id: `box:${box}`, label: `Box ${box} total`, nodeId: total?.nodeId, cells: { count: { value: ls.length }, gain: total ?? { value: sum }, lotsGain: { value: sum } }, flags: flags.length ? flags : undefined };
  });

  // Broker summary vs extracted lot detail.
  const sdRows: ViewRow[] = [];
  const findings: ViewFlag[] = [];
  for (const d of ctx.packet.documents) {
    const sumEvs = ctx.docEvs(d.id).filter((e) => ['b_summary_proceeds', 'st_proceeds', 'lt_proceeds'].includes(e.field) || (d.document_type === '1099-DA' && e.field === 'total'));
    if (!sumEvs.length) continue;
    const summary = round2(sumEvs.reduce((s, e) => s + n(e.value), 0));
    const lotEvs = ctx.wp.b.packet.extracted_values.filter((e) => /_proceeds$/.test(e.field) && e.document_id === d.id && !sumEvs.includes(e));
    const detailLots = all.filter((l) => l.sources.some((s) => lotEvs.some((e) => e.id === s)));
    const detail = round2(detailLots.reduce((s, l) => s + l.proceeds, 0));
    const diff = round2(summary - detail);
    const superseded = (ctx.wp.b.version(ctx.v)!.documents_superseded as string[]).includes(d.id);
    const flags: ViewFlag[] = [];
    if (Math.abs(diff) > 0.5 && !superseded) {
      const unextracted = d.extraction.status !== 'extracted' ? ` (${d.extraction.reason ?? 'document only partly extracted'})` : '';
      const fl: ViewFlag = { code: 'SUMMARY_DETAIL', severity: 'warning', text: `${d.issuer} 1099 summary proceeds ${fmt(summary)} vs lot detail ${fmt(detail)}: ${fmt(diff)} not in the detail${unextracted}`, nodeIds: [...sumEvs.map((e) => `ev:${e.id}`), `doc:${d.id}`] };
      flags.push(fl);
      findings.push(fl);
    }
    sdRows.push({
      id: d.id,
      label: `${d.issuer} (${d.id})`,
      sublabel: superseded ? 'superseded document' : d.title,
      nodeId: `doc:${d.id}`,
      cells: { summary: { value: summary, nodeId: `ev:${sumEvs[0]!.id}` }, detail: { value: detail }, difference: { value: diff }, count: { value: detailLots.length } },
      flags: flags.length ? flags : undefined,
    });
  }

  const zero = exceptions.filter((l) => l.flags.some((f) => f.code === 'ZERO_BASIS'));
  if (zero.length)
    findings.unshift({ code: 'ZERO_BASIS', severity: 'error', text: `${zero.length} lot(s) reported with zero basis: ${zero.map((l) => l.key).join(', ')}`, nodeIds: zero.map((l) => lineId(ctx.v, l.key)) });
  const wash = exceptions.filter((l) => l.adjCode === 'W');
  if (wash.length) findings.push({ code: 'WASH_SALE', severity: 'info', text: `${wash.length} wash-sale lot(s), ${fmt(round2(wash.reduce((s, l) => s + l.adjAmount, 0)))} disallowed`, nodeIds: wash.map((l) => lineId(ctx.v, l.key)) });

  return ctx.view(
    'sales',
    'Sales detail (Form 8949)',
    'Every lot grouped by 8949 box, term and broker, exceptions first: zero or missing basis, low-confidence reads, wash sales, summary-vs-detail differences, lots from superseded documents, lots changed between engine versions and adjusted lots.',
    [
      { id: 'exceptions', title: `Exceptions (${exceptions.length})`, columns: cols, rows: exceptions.map((l) => lotRow(ctx, l)) },
      { id: 'groups', title: 'By box, term and broker', columns: [{ key: 'count', label: 'Lots', kind: 'number' }, ...cols], rows: groupRows, totals: boxTotals },
      { id: 'summary-vs-detail', title: 'Broker summary vs lot detail', columns: [money('summary', '1099 summary proceeds'), money('detail', 'Sum of lots'), money('difference', 'Difference'), { key: 'count', label: 'Lots', kind: 'number' }], rows: sdRows },
      { id: 'lots', title: `All lots (${all.length})`, note: 'Exceptions first, then by size of gain.', columns: [...cols, text('box', 'Box')], rows: all.map((l) => lotRow(ctx, l)) },
    ],
    findings,
    { lots: all.length, exceptions: exceptions.length, valueUnit: 'dollars (to the cent)' },
  );
}
