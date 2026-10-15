// Payments: federal and California payments claimed on the return vs the IRS account
// transcript and the FTB account (third-party agreement). Shared with filing readiness.

import type { ViewCell, ViewDto, ViewFlag, ViewRow } from '@easetax/shared';
import { compact, date, fmt, money, n, text, type ViewCtx } from './ctx.ts';

interface Claimed {
  date: string | null;
  amount: number;
  nodeId: string;
  dateNodeId?: string;
  source: string;
}
interface Record_ {
  date: string;
  amount: number;
  nodeId: string;
  description: string;
}

export interface JurisdictionPayments {
  jurisdiction: 'federal' | 'california';
  line: string;
  claimed: number;
  engineClaimed: number;
  record: number;
  difference: number;
  reconciliation?: { explanation: string; status: string; by: string; at: string };
  agreed: boolean;
  rows: ViewRow[];
  findings: ViewFlag[];
}

const within = (a: string | null, b: string, days: number) => !!a && Math.abs(Date.parse(a) - Date.parse(b)) <= days * 86_400_000;
const isoFromText = (s: string): string | null => {
  const m = /(January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/.exec(s);
  if (!m) return null;
  const t = Date.parse(m[0] + (m[0].includes(',') ? ' UTC' : ''));
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
};
const amountFromText = (s: string): number | null => {
  const m = /(\d{1,3}(?:,\d{3})+|\d{4,})(?:\.\d{2})?/.exec(s.replace(/\b\d{4}-\d{2}-\d{2}\b|\b(19|20)\d{2}\b/g, ''));
  return m ? Number(m[1]!.replace(/,/g, '')) : null;
};

/** Payment lines from a confirmation document, pairing <prefix>_amount with <prefix>_date (and _year). */
function confirmations(ctx: ViewCtx, docType: string, issuerRe: RegExp) {
  const out: (Claimed & { year?: string; yearNodeId?: string })[] = [];
  for (const d of ctx.docsOfType(docType).filter((x) => issuerRe.test(x.issuer))) {
    for (const e of ctx.docEvs(d.id)) {
      const m = /^(.*)_amount$/.exec(e.field);
      if (!m) continue;
      const dt = ctx.docEv(d.id, `${m[1]}_date`);
      const yr = ctx.docEv(d.id, `${m[1]}_year`);
      out.push({
        date: dt ? String(dt.value) : null,
        amount: n(e.value),
        nodeId: `ev:${e.id}`,
        dateNodeId: dt && `ev:${dt.id}`,
        source: d.id,
        year: yr ? String(yr.value) : undefined,
        yearNodeId: yr && `ev:${yr.id}`,
      });
    }
  }
  return out;
}

export function federalPayments(ctx: ViewCtx): JurisdictionPayments {
  const year = ctx.packet.household.tax_year;
  const line = 'F1040.26';
  const c = ctx.cell(line);
  const claimedTotal = n(c?.value);
  const claimed: Claimed[] = confirmations(ctx, 'payment_confirmation', /EFTPS|Treasury/i);
  const documented = claimed.reduce((s, x) => s + x.amount, 0);
  if (claimedTotal - documented > 0) {
    // The rest of the claimed total rests on the client's word; find the answer that states it.
    const qa = ctx.packet.client.questionnaire.find((q) => /estimated/i.test(q.question) && amountFromText(q.answer) !== null && /quarter|Q4|4th/i.test(q.question));
    claimed.push({ date: qa ? isoFromText(qa.answer) : null, amount: claimedTotal - documented, nodeId: qa ? `qa:${qa.id}` : c!.nodeId!, source: qa ? qa.id : 'undocumented' });
  }
  // Latest transcript snapshot; 670 payments with numeric amounts.
  const snaps = (ctx.packet.tax_agency_records.irs_account_transcript_2025 ?? []) as { as_of: string; transactions: { date: string; code: string; description: string; amount: unknown }[] }[];
  const si = snaps.length - 1;
  const records: Record_[] = [];
  const extension: Record_[] = [];
  (snaps[si]?.transactions ?? []).forEach((t, j) => {
    if (t.code !== '670' || typeof t.amount !== 'number') return;
    const r = { date: t.date, amount: t.amount, nodeId: `agency:/irs_account_transcript_2025/${si}/transactions/${j}`, description: t.description };
    (/extension|4868/i.test(t.description) ? extension : records).push(r);
  });
  const estRecords = records.filter((r) => r.date >= `${year}-01-01` && r.date <= `${year + 1}-01-31`);
  const out = reconcile(ctx, 'federal', line, claimed, estRecords, 5);

  // Extension payment: Schedule 3 line 10 vs the transcript.
  const ext = ctx.cell('Sch3.10');
  if (ext) {
    const recExt = extension.reduce((s, r) => s + r.amount, 0);
    const diff = n(ext.value) - recExt;
    const flags: ViewFlag[] = diff ? [{ code: 'EXTENSION_PAYMENT', severity: 'warning', text: `Extension payment claimed ${fmt(n(ext.value))}; transcript ${fmt(recExt)}`, nodeIds: compact([ext.nodeId, extension[0]?.nodeId]) }] : [];
    out.rows.push({ id: 'extension', label: 'Payment with extension (Form 4868)', sublabel: 'Schedule 3 line 10', nodeId: ext.nodeId, cells: { claimed: ext, claimedDate: { value: extension[0]?.date ?? null }, record: { value: recExt, nodeId: extension[0]?.nodeId }, recordDate: { value: extension[0]?.date ?? null }, difference: { value: diff } }, flags: flags.length ? flags : undefined });
    out.findings.push(...flags);
  }
  return out;
}

export function californiaPayments(ctx: ViewCtx): JurisdictionPayments {
  const year = String(ctx.packet.household.tax_year);
  const line = 'F540NR.72';
  const webPay = confirmations(ctx, 'payment_confirmation', /Franchise Tax Board|FTB/i);
  const ftb = (ctx.packet.tax_agency_records.ftb_account ?? {}) as Record<string, any>;
  const records: (Record_ & { appliedTo: string })[] = [];
  for (const [k, list] of Object.entries(ftb)) {
    const m = /^tax_year_(\d{4})_payments/.exec(k);
    if (!m || !Array.isArray(list)) continue;
    list.forEach((p: any, j: number) => records.push({ date: p.date, amount: n(p.amount), nodeId: `agency:/ftb_account/${k}/${j}`, description: p.note ?? `Applied to tax year ${m[1]}`, appliedTo: m[1]! }));
  }
  // Which confirmations make up the claimed total: the subset of Web Pay payments dated in the
  // estimate window whose sum equals the line (the engine does not say); else all of them.
  const inWindow = webPay.filter((p) => p.date && p.date > `${year}-01-15` && p.date <= `${Number(year) + 1}-01-15`);
  const target = n(ctx.cell(line)?.engineValue);
  const window = subsetSumming(inWindow, target) ?? inWindow;
  const claimed: Claimed[] = window.map((p) => ({ ...p }));
  const r2025 = records.filter((r) => r.appliedTo === year);
  const out = reconcile(ctx, 'california', line, claimed, r2025, 3);
  // Payments the FTB applied to another year: explain them row by row.
  for (const r of records.filter((x) => x.appliedTo !== year)) {
    const pay = webPay.find((p) => within(p.date, r.date, 3) && p.amount === r.amount);
    const fl: ViewFlag = {
      code: 'PAYMENT_APPLIED_OTHER_YEAR',
      severity: pay && window.includes(pay) ? 'error' : 'info',
      text: `${fmt(r.amount)} paid ${r.date} was applied by the FTB to tax year ${r.appliedTo}${pay?.year ? ` (Web Pay designation: ${pay.year})` : ''}${pay && window.includes(pay) ? ' but is counted in the 2025 estimated payments claimed' : ''}`,
      nodeIds: compact([r.nodeId, pay?.nodeId, pay?.yearNodeId]),
    };
    const row = out.rows.find((x) => x.cells.claimed?.nodeId === pay?.nodeId);
    if (row) row.flags = [...(row.flags ?? []), fl];
    else out.rows.push({ id: r.nodeId, label: `FTB record ${r.date}`, nodeId: r.nodeId, cells: { record: { value: r.amount, nodeId: r.nodeId }, recordDate: { value: r.date } }, flags: [fl] });
    out.findings.unshift(fl);
  }
  // Extension (FTB 3519).
  const ext = ctx.cell('F540NR.73');
  const planned = n(ctx.packet.what_if?.extension?.california?.paid_with_ftb_3519);
  if (ext) out.rows.push({ id: 'extension', label: 'Extension payment (FTB 3519)', nodeId: ext.nodeId, cells: { claimed: ext, record: { value: planned, note: 'what_if.extension (no FTB record of a 3519 payment)' }, difference: { value: n(ext.value) - planned } } });
  return out;
}

/** Smallest-index subset whose amounts sum to `target` (n ≤ 16), preferring the most items. */
function subsetSumming<T extends { amount: number }>(items: T[], target: number): T[] | null {
  if (items.length > 16) return null;
  let best: T[] | null = null;
  for (let mask = 1; mask < 1 << items.length; mask++) {
    const pick = items.filter((_, i) => mask & (1 << i));
    if (Math.abs(pick.reduce((s, x) => s + x.amount, 0) - target) < 0.005 && (!best || pick.length > best.length)) best = pick;
  }
  return best;
}

function reconcile(ctx: ViewCtx, jurisdiction: 'federal' | 'california', line: string, claimed: Claimed[], records: Record_[], days: number): JurisdictionPayments {
  const c = ctx.cell(line)!;
  const used = new Set<Record_>();
  const rows: ViewRow[] = [];
  const findings: ViewFlag[] = [];
  for (const cl of claimed.sort((a, b) => (a.date ?? '9').localeCompare(b.date ?? '9'))) {
    const rec = records.find((r) => !used.has(r) && within(cl.date, r.date, days));
    if (rec) used.add(rec);
    const diff = cl.amount - (rec?.amount ?? 0);
    const flags: ViewFlag[] = [];
    if (diff !== 0) {
      const f: ViewFlag = {
        code: 'PAYMENT_DIFFERENCE',
        severity: 'error',
        text: rec
          ? `${jurisdiction === 'federal' ? 'Federal' : 'California'} payment ${cl.date}: claimed ${fmt(cl.amount)} (${cl.source}) vs ${jurisdiction === 'federal' ? 'IRS transcript' : 'FTB account'} ${fmt(rec.amount)} on ${rec.date}: difference ${fmt(diff)}`
          : `${jurisdiction === 'federal' ? 'Federal' : 'California'} payment ${cl.date ?? '(no date)'} of ${fmt(cl.amount)} (${cl.source}) not found in the ${jurisdiction === 'federal' ? 'IRS transcript' : 'FTB account'}`,
        nodeIds: compact([c.nodeId, cl.nodeId, rec?.nodeId]),
      };
      // An unmatched payment the FTB applied elsewhere is explained by that row's own flag.
      if (rec || jurisdiction === 'federal') {
        flags.push(f);
        findings.push(f);
      }
    }
    rows.push({
      id: cl.nodeId,
      label: `Payment ${cl.date ?? '(date unknown)'}`,
      sublabel: `Claimed per ${cl.source}`,
      nodeId: cl.nodeId,
      cells: { claimed: { value: cl.amount, nodeId: cl.nodeId }, claimedDate: { value: cl.date, nodeId: cl.dateNodeId }, record: rec ? { value: rec.amount, nodeId: rec.nodeId } : { value: null }, recordDate: { value: rec?.date ?? null }, difference: { value: diff } },
      flags: flags.length ? flags : undefined,
    });
  }
  for (const r of records.filter((x) => !used.has(x))) {
    const f: ViewFlag = { code: 'PAYMENT_NOT_CLAIMED', severity: 'warning', text: `${jurisdiction === 'federal' ? 'IRS' : 'FTB'} shows ${fmt(r.amount)} on ${r.date} not matched to a claimed payment`, nodeIds: [r.nodeId] };
    rows.push({ id: r.nodeId, label: `Record ${r.date}`, sublabel: r.description, nodeId: r.nodeId, cells: { record: { value: r.amount, nodeId: r.nodeId }, recordDate: { value: r.date }, difference: { value: -r.amount } }, flags: [f] });
    findings.push(f);
  }
  const record = records.reduce((s, r) => s + r.amount, 0);
  const claimedTotal = n(c.value);
  const difference = claimedTotal - record;
  const reconciliation = ctx.wp.state.reconciliations.get(`payments:${jurisdiction}`);
  const total: ViewRow = {
    id: `total:${jurisdiction}`,
    label: `Estimated payments: return vs ${jurisdiction === 'federal' ? 'IRS transcript' : 'FTB account'}`,
    nodeId: c.nodeId,
    status: difference === 0 ? 'agreed' : reconciliation ? `explained (${reconciliation.status})` : 'difference',
    cells: { claimed: c as ViewCell, record: { value: record }, difference: { value: difference } },
  };
  if (difference !== 0)
    findings.push({
      code: 'PAYMENTS_TOTAL',
      severity: reconciliation ? 'info' : 'error',
      text: `${jurisdiction === 'federal' ? 'Federal' : 'California'} estimated payments claimed ${fmt(claimedTotal)} vs ${jurisdiction === 'federal' ? 'IRS transcript' : 'FTB account'} ${fmt(record)}: payments overstated ${fmt(difference)}${reconciliation ? ' (explained)' : ''}`,
      nodeIds: [c.nodeId!],
    });
  rows.push(total);
  return { jurisdiction, line, claimed: claimedTotal, engineClaimed: n(c.engineValue), record, difference, reconciliation, agreed: difference === 0 || !!reconciliation, rows, findings };
}

export function payments(ctx: ViewCtx): ViewDto {
  const fed = federalPayments(ctx);
  const ca = californiaPayments(ctx);
  const cols = [money('claimed', 'Claimed'), date('claimedDate', 'Date claimed'), money('record', 'Agency record'), date('recordDate', 'Date per agency'), money('difference', 'Difference')];
  const withholding = compact(['F1040.25a', 'F1040.25d', 'Sch3.11', 'F540NR.71'].map((k) => {
    const c = ctx.cell(k);
    if (!c) return undefined;
    const l = ctx.line(k)!;
    return { id: k, label: l.label, sublabel: `${l.form} ${l.line} · sources ${l.sources.join(', ')}`, nodeId: c.nodeId, cells: { claimed: c }, links: l.sources.map((s) => `ev:${s}`) } as ViewRow;
  }));
  return ctx.view(
    'payments',
    'Payments',
    'Federal and California payments claimed on the return vs the IRS account transcript and the FTB account, payment by payment.',
    [
      { id: 'federal', title: 'Federal estimated and extension payments', columns: cols, rows: fed.rows },
      { id: 'california', title: 'California estimated and extension payments', columns: cols, rows: ca.rows },
      { id: 'withholding', title: 'Withholding (no agency record; agreed to W-2s)', columns: [money('claimed', 'Claimed'), text('note', 'Note')], rows: withholding },
    ],
    [...fed.findings, ...ca.findings],
    { federal: { claimed: fed.claimed, record: fed.record, difference: fed.difference, agreed: fed.agreed }, california: { claimed: ca.claimed, record: ca.record, difference: ca.difference, agreed: ca.agreed } },
  );
}
