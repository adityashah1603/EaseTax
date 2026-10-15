// Completeness proof (FR-4.5): every document has a disposition, every area is considered,
// every outside filing is identified with a status.

import type { ViewDto, ViewFlag, ViewRow } from '@easetax/shared';
import { diagId } from '@easetax/shared';
import { AREAS } from '../baseline/areas.ts';
import { relatedReturns } from '../baseline/related.ts';
import { compact, fmt, status, text, type ViewCtx } from './ctx.ts';

export interface OutsideFiling {
  id: string;
  title: string;
  why: string;
  triggered: boolean;
  nodeIds: string[];
  status: 'addressed' | 'open' | 'outside scope';
  decision?: string;
}

export function outsideFilings(ctx: ViewCtx): OutsideFiling[] {
  const v = ctx.v;
  const diag = (code: string) => (ctx.wp.b.version(v)!.diagnostics.some((d) => d.code === code) ? diagId(v, code) : undefined);
  const engagement = ctx.docsOfType('engagement_letter')[0];
  const qa = (re: RegExp) => ctx.packet.client.questionnaire.find((q) => re.test(q.question));
  const out: Omit<OutsideFiling, 'status' | 'decision'>[] = [];

  const fbarMax = ctx.num('F8938.1.max');
  out.push({
    id: 'fbar',
    title: 'FinCEN Form 114 (FBAR)',
    why: `Foreign account maximum ${fmt(fbarMax)} USD exceeds 10,000; filed separately with FinCEN (prior preparer note: client filed it himself)`,
    triggered: fbarMax > 10000,
    nodeIds: compact([ctx.cell('F8938.1.max')?.nodeId, diag('FBAR_OUTSIDE_RETURN'), engagement && `doc:${engagement.id}`]),
  });
  const paid = ctx.cell('SchC.I');
  const filed = ctx.cell('SchC.J');
  const contractors = ctx.docsOfType('books_report')[0];
  out.push({
    id: '1099-nec',
    title: 'Forms 1099-NEC for the business’s contractors',
    why: `Schedule C: payments requiring 1099s = ${paid?.value ?? '?'}; filed = ${filed?.value ?? '?'}`,
    triggered: String(paid?.value) === 'Yes' && String(filed?.value) !== 'Yes',
    nodeIds: compact([paid?.nodeId, filed?.nodeId, diag('FORM_1099_FILING'), contractors && `doc:${contractors.id}`, qa(/1099-NEC/i) && `qa:${qa(/1099-NEC/i)!.id}`]),
  });
  out.push({
    id: 'form-709',
    title: 'Form 709 (gift tax return)',
    why: 'Consider whether any 2025 non-charitable gifts exceeded the annual exclusion (e.g. support beyond a dependent, transfers to children); gift tax returns are outside the engagement letter',
    triggered: true,
    nodeIds: compact([engagement && `doc:${engagement.id}`, ctx.cell('SchA.12')?.nodeId]),
  });
  for (const r of ctx.packet.household.related_returns) {
    const person = ctx.packet.household.people.find((p) => r.who.startsWith(p.name.split(' ')[0]!));
    const own = /own/i.test(r.return);
    out.push({
      id: `related:${r.who}`,
      title: `${r.who}: ${r.return}`,
      why: own ? `Prepared by ${r.prepared_by}; must be consistent with this return claiming them as a dependent` : `Prepared by ${r.prepared_by}; ${r.in_this_packet ? `in packet: ${r.in_this_packet}` : 'not in packet'}`,
      triggered: true,
      nodeIds: compact([relatedReturns(ctx.wp.b).find((x) => x.who === r.who)?.id, person && `household:${person.id}`, own ? ctx.cell('F8812.6')?.nodeId : undefined]),
    });
  }
  const ppw = ctx.packet.prior_years.prior_preparer_workpaper ?? {};
  (ppw.open_items_left_by_prior_preparer ?? []).forEach((t: string, i: number) => {
    if (!/3520/.test(t)) return;
    out.push({
      id: 'form-3520',
      title: 'Form 3520 (2023 foreign inheritance)',
      why: `Prior preparer open item: ${t}`,
      triggered: true,
      nodeIds: compact([`py:/prior_preparer_workpaper/open_items_left_by_prior_preparer/${i}`, ...ctx.docsOfType('foreign_bank_statement').map((d) => `doc:${d.id}`), ctx.cell('SchB.8')?.nodeId]),
    });
  });

  const judgments = [...ctx.wp.state.judgments.values()];
  const KEYWORDS: Record<string, RegExp> = { fbar: /FBAR|114/i, '1099-nec': /1099-NEC|1099s?\b/i, 'form-709': /709|gift tax/i, 'form-3520': /3520/i };
  return out.map((o) => {
    const kw = KEYWORDS[o.id] ?? new RegExp(o.title.split(':')[0]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const j = judgments.find((x) => kw.test(`${x.topic} ${x.decision}`) || x.nodeIds.some((id) => o.nodeIds.includes(id) && kw.test(x.topic)));
    const outside = o.id.startsWith('related:') && !/own/i.test(o.title);
    return { ...o, status: j ? 'addressed' : outside ? 'outside scope' : 'open', decision: j ? `${j.decision} (${j.authority}; ${j.by})` : undefined };
  });
}

export function completeness(ctx: ViewCtx): ViewDto {
  const findings: ViewFlag[] = [];
  const taxYear = ctx.packet.household.tax_year;
  const docs = ctx.wp.documents();
  const docRows: ViewRow[] = docs.map((d) => {
    const flags: ViewFlag[] = [];
    if (!d.disposition || d.disposition.status === 'pending') flags.push({ code: 'NO_DISPOSITION', severity: 'warning', text: 'No disposition recorded', nodeIds: [`doc:${d.id}`] });
    if (d.taxYear !== taxYear && d.linesFed > 0 && d.disposition?.status !== 'out_of_year')
      flags.push({ code: 'OUT_OF_YEAR_FEEDS', severity: 'info', text: `${d.taxYear} document feeds ${d.linesFed} 2025 line(s); confirm it is used only for carryforward/basis`, nodeIds: [`doc:${d.id}`] });
    return {
      id: d.id,
      label: d.title,
      sublabel: `${d.documentType} · ${d.issuer} · ${d.taxYear} · received ${d.receivedAt.slice(0, 10)}`,
      nodeId: `doc:${d.id}`,
      status: d.disposition ? d.disposition.status + (d.disposition.derived ? ' (derived)' : '') : 'none',
      cells: { disposition: { value: d.disposition?.status ?? null }, note: { value: d.disposition?.note ?? '' }, linesFed: { value: d.linesFed }, by: { value: d.disposition ? `${d.disposition.by} ${d.disposition.at.slice(0, 10)}` : '' } },
      flags: flags.length ? flags : undefined,
    };
  });
  const missing = docRows.filter((r) => r.flags?.some((f) => f.code === 'NO_DISPOSITION'));
  if (missing.length) findings.push({ code: 'DOCS_UNACCOUNTED', severity: 'warning', text: `${missing.length} of ${docs.length} documents have no disposition`, nodeIds: missing.map((r) => r.nodeId!) });

  const areaRows: ViewRow[] = AREAS.map((a) => {
    const c = ctx.wp.state.areaConsidered.get(a.id);
    const so = [...ctx.wp.state.signoffs.values()].filter((s) => s.scope === `area:${a.id}` && s.status === 'valid');
    return {
      id: a.id,
      label: a.title,
      sublabel: a.forms.join(', '),
      status: c ? 'considered' : 'not yet considered',
      cells: { considered: { value: c ? `${c.by} ${c.at.slice(0, 10)}${c.note ? ': ' + c.note : ''}` : '' }, signoffs: { value: so.map((s) => `${s.level} ${s.by}`).join(', ') } },
      flags: c ? undefined : [{ code: 'AREA_NOT_CONSIDERED', severity: 'info', text: 'Area not marked considered' }],
    };
  });
  const notConsidered = areaRows.filter((r) => r.status !== 'considered').length;
  if (notConsidered) findings.push({ code: 'AREAS_NOT_CONSIDERED', severity: 'info', text: `${notConsidered} of ${AREAS.length} areas not yet marked considered` });

  const of = outsideFilings(ctx);
  const ofRows: ViewRow[] = of.map((o) => ({
    id: o.id,
    label: o.title,
    sublabel: o.why,
    nodeId: o.nodeIds[0],
    status: o.status,
    cells: { status: { value: o.status }, decision: { value: o.decision ?? '' } },
    links: o.nodeIds,
    flags: o.status === 'open' ? [{ code: 'OUTSIDE_FILING_OPEN', severity: 'warning', text: `${o.title}: identified, no decision recorded`, nodeIds: o.nodeIds }] : undefined,
  }));
  const openOf = of.filter((o) => o.status === 'open');
  if (openOf.length) findings.push({ code: 'OUTSIDE_FILINGS_OPEN', severity: 'warning', text: `${openOf.length} outside filing(s) identified without a recorded decision: ${openOf.map((o) => o.title.split(' (')[0]).join('; ')}`, nodeIds: openOf.flatMap((o) => o.nodeIds.slice(0, 1)) });

  const counts: Record<string, number> = {};
  for (const d of docs) counts[d.disposition?.status ?? 'none'] = (counts[d.disposition?.status ?? 'none'] ?? 0) + 1;
  return ctx.view(
    'completeness',
    'Completeness',
    'Every document with its disposition, every review area considered, and every outside filing identified with its status.',
    [
      { id: 'documents', title: `Documents (${docs.length})`, columns: [status('disposition', 'Disposition'), text('note', 'Note'), { key: 'linesFed', label: 'Lines fed', kind: 'number' }, text('by', 'By')], rows: docRows },
      { id: 'areas', title: 'Review areas', columns: [text('considered', 'Considered'), text('signoffs', 'Valid sign-offs')], rows: areaRows },
      { id: 'outside-filings', title: 'Outside filings', columns: [status('status', 'Status'), text('decision', 'Decision')], rows: ofRows },
    ],
    findings,
    { dispositionCounts: counts },
  );
}
