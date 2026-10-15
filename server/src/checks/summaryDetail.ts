// Summary vs detail: broker statements against the Form 8949 lots built from them.
//
//  sd.broker_lots          every lot printed on a broker statement (including pages the
//                          pipeline did not extract) must appear on Form 8949 with the
//                          printed proceeds, basis and wash-sale adjustment
//  sd.supplemental_basis   lots the broker reported with no basis must use the adjusted
//                          basis from the employer's supplemental statement when one exists

import type { ReturnLine } from '@easetax/shared';
import { registerCheck, type CheckContext, type CheckIssue } from './registry.ts';
import {
  E,
  L,
  P,
  docsInUse,
  evsOfDoc,
  fmt,
  issue,
  lineNum,
  lines,
  nameWords,
  normText,
  num,
  parseMoney,
  r2,
  suggest,
} from './util.ts';

export interface PrintedLot {
  id: string;
  description: string;
  acquired: string;
  sold: string;
  proceeds: number;
  basis: number | null;
  wash: number;
  term: 'short' | 'long';
  covered: boolean;
  page: number;
}

const LOT_RE =
  /\b([A-Z]{1,3}\d+)\s+(.+?)\s+[\d.,]+\s+(?:sh|units)\s+acquired\s+(\d{4}-\d{2}-\d{2})\s+sold\s+(\d{4}-\d{2}-\d{2})\s+proceeds\s+([\d,]+\.\d{2})\s+basis\s+([\d,]+\.\d{2}|\(not reported\))(?:\s+wash sale loss disallowed\s+([\d,]+\.\d{2}))?\s+(short|long)-term\s+(covered|noncovered)/g;

export function printedLots(ctx: CheckContext, docId: string): PrintedLot[] {
  const out: PrintedLot[] = [];
  for (const p of ctx.b.docs.get(docId)?.pages ?? []) {
    for (const m of p.printed_content.matchAll(LOT_RE)) {
      out.push({
        id: m[1]!,
        description: m[2]!,
        acquired: m[3]!,
        sold: m[4]!,
        proceeds: parseMoney(m[5]!),
        basis: m[6]!.startsWith('(') ? null : parseMoney(m[6]!),
        wash: m[7] ? parseMoney(m[7]) : 0,
        term: m[8] as 'short' | 'long',
        covered: m[9] === 'covered',
        page: p.page,
      });
    }
  }
  return out;
}

/** Form 8949 box for a lot reported on a 1099-B (A/B/D/E). */
const boxFor = (lot: PrintedLot) => (lot.term === 'short' ? (lot.covered ? 'A' : 'B') : lot.covered ? 'D' : 'E');

function lotLines(ctx: CheckContext): Map<string, ReturnLine> {
  const m = new Map<string, ReturnLine>();
  for (const l of lines(ctx)) {
    if (l.form !== 'F8949') continue;
    const lot = l.line.split('.')[1];
    if (lot && lot !== 'total') m.set(lot, l);
  }
  return m;
}

registerCheck({
  id: 'sd.broker_lots',
  title: 'Every printed broker lot is on Form 8949 as printed',
  family: 'summary_vs_detail',
  run(ctx) {
    const out: CheckIssue[] = [];
    const byLot = lotLines(ctx);
    for (const docId of docsInUse(ctx)) {
      const d = ctx.b.docs.get(docId)!;
      if (!/1099-(composite|B)/i.test(d.document_type)) continue;
      const lots = printedLots(ctx, docId);
      if (!lots.length) continue;
      const evs = evsOfDoc(ctx, docId);
      const extractedPages = new Set(evs.map((e) => e.page));
      const summary = evs.find((e) => /summary_proceeds|^total_proceeds/.test(e.field));
      const extractedLotProceeds = r2(
        evs.filter((e) => /_proceeds$/.test(e.field) && e !== summary).reduce((s, e) => s + (num(e.value) ?? 0), 0),
      );
      for (const lot of lots) {
        const l = byLot.get(lot.id);
        const expected = r2(lot.proceeds - (lot.basis ?? 0) + lot.wash);
        if (!l) {
          const box = boxFor(lot);
          const totalKey = `F8949.${box}.total`;
          const total = lineNum(ctx, totalKey);
          out.push(
            issue('sd.broker_lots', `${docId}:${lot.id}`, {
              code: 'BROKER_LOT_MISSING',
              severity: 'error',
              title: `${d.issuer} lot ${lot.id} (${fmt(expected)} ${expected < 0 ? 'loss' : 'gain'}) is missing from Form 8949`,
              detail:
                `${d.title}, page ${lot.page}${extractedPages.has(lot.page) ? '' : ' (not extracted by the pipeline)'}: ` +
                `${lot.id} ${lot.description} acquired ${lot.acquired} sold ${lot.sold}, proceeds ${fmt(lot.proceeds)}, basis ${lot.basis === null ? 'not reported' : fmt(lot.basis)}, ` +
                `${lot.term}-term ${lot.covered ? 'covered' : 'noncovered'} → box ${box}. ` +
                (summary ? `Statement summary proceeds ${fmt(num(summary.value) ?? 0)} vs extracted lots ${fmt(extractedLotProceeds)}. ` : '') +
                '(§8 E11)',
              nodeIds: [P(docId, lot.page), `doc:${docId}`, summary && E(summary.id), total !== undefined && L(ctx, totalKey)],
              ...(total !== undefined ? suggest(ctx, totalKey, r2(total + expected), `Add ${lot.id} from ${docId} page ${lot.page}`) : {}),
            }),
          );
          continue;
        }
        const cur = lineNum(ctx, l.key);
        if (lot.basis === null || cur === undefined) continue; // no-basis lots: sd.supplemental_basis
        // A lot that also cites another document (e.g. an ESPP basis adjustment from the
        // employer's supplemental statement) is verified by sd.supplemental_basis.
        if (l.sources.some((s) => ctx.b.evs.get(s) && ctx.b.evs.get(s)!.document_id !== docId)) continue;
        const box = l.line.split('.')[0]!;
        const termOk = (lot.term === 'short') === ['A', 'B', 'C', 'G', 'H', 'I'].includes(box);
        if (Math.abs(cur - expected) <= 0.5 && termOk) continue;
        out.push(
          issue('sd.broker_lots', `${docId}:${lot.id}`, {
            code: 'BROKER_LOT_DIFFERS',
            severity: 'error',
            title: `${l.key} differs from ${d.issuer} lot ${lot.id} as printed`,
            detail:
              `Printed: proceeds ${fmt(lot.proceeds)} basis ${fmt(lot.basis)} wash ${fmt(lot.wash)} → ${fmt(expected)} (${lot.term}-term). ` +
              `Return: ${fmt(cur)} in box ${box}.`,
            nodeIds: [L(ctx, l.key), P(docId, lot.page), `doc:${docId}`],
            ...(termOk ? suggest(ctx, l.key, expected, `As printed on ${docId} page ${lot.page}`) : {}),
          }),
        );
      }
    }
    return out;
  },
});

/** "… proceeds 19,240.00, basis 0.00, adjustment B -675.00" from a Form 8949 lot label. */
function parseLotLabel(label: string) {
  const m = /acquired (\d{4}-\d{2}-\d{2}), sold (\d{4}-\d{2}-\d{2}); proceeds ([\d,.]+), basis ([\d,.]+)(?:, adjustment \w+ (-?[\d,.]+))?/.exec(label);
  if (!m) return undefined;
  return { acquired: m[1]!, sold: m[2]!, proceeds: parseMoney(m[3]!), basis: parseMoney(m[4]!), adjustment: m[5] ? parseMoney(m[5]) : 0 };
}

registerCheck({
  id: 'sd.supplemental_basis',
  title: 'Broker basis replaced by the supplemental adjusted basis',
  family: 'summary_vs_detail',
  run(ctx) {
    const out: CheckIssue[] = [];
    const lotLs = [...lotLines(ctx).values()];
    for (const docId of docsInUse(ctx)) {
      const d = ctx.b.docs.get(docId)!;
      if (d.document_type !== 'stock_plan_supplement') continue;
      const evs = evsOfDoc(ctx, docId);
      const issuerWord = nameWords(d.issuer)[0] ?? '';
      for (const b of evs.filter((e) => /_adjusted_basis$/.test(e.field))) {
        const lotId = b.field.replace(/_adjusted_basis$/, '');
        const acq = evs.find((e) => e.field === `${lotId}_acquired`);
        const adj = num(b.value);
        if (!acq || adj === undefined) continue;
        const l = lotLs.find((x) => normText(x.label).includes(issuerWord) && parseLotLabel(x.label)?.acquired === acq.value);
        if (!l) continue;
        const lab = parseLotLabel(l.label)!;
        const cur = lineNum(ctx, l.key);
        if (cur === undefined) continue;
        const expected = r2(lab.proceeds - adj);
        if (Math.abs(cur - expected) <= 0.5) continue; // already uses the adjusted basis (e.g. ESPP with adjustment B)
        const brokerEvs = l.sources.filter((s) => /^ev-/.test(s));
        out.push(
          issue('sd.supplemental_basis', l.key, {
            code: 'BASIS_FROM_SUPPLEMENT',
            severity: 'error',
            title: `${l.form} ${l.line}: basis ${fmt(lab.basis)} ignores ${lotId} adjusted basis ${fmt(adj)} (${d.id})`,
            detail:
              `${l.label}. ${d.title} gives ${lotId} acquired ${String(acq.value)} an adjusted basis of ${fmt(adj)} (already taxed as wages). ` +
              `Gain should be ${fmt(lab.proceeds)} − ${fmt(adj)} = ${fmt(expected)}, not ${fmt(cur)}: overstated by ${fmt(r2(cur - expected))}. (§8 E8)`,
            nodeIds: [L(ctx, l.key), E(b.id), E(acq.id), `doc:${docId}`, P(docId, b.page), ...brokerEvs.map(E)],
            ...suggest(ctx, l.key, expected, `Adjusted basis ${fmt(adj)} from ${d.id} (${lotId})`),
          }),
        );
      }
    }
    return out;
  },
});
