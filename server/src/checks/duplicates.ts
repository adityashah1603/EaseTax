// Duplicate and supersession checks: the same money arriving twice.
//
//  dup.document      two documents of the same type/issuer/EIN carrying the same amounts
//  dup.supersession  a CORRECTED document versus the original it replaces
//  dup.page          a page of a document that repeats an earlier page (rescans)
//  dup.cross_line    two return lines carrying the same amount from linked documents
//  dup.within_line   one line summing a statement that says it is already on the other form

import type { ExtractedValue, ReturnLine } from '@easetax/shared';
import { registerCheck, type CheckContext, type CheckIssue } from './registry.ts';
import {
  E,
  EIN_RE,
  L,
  P,
  docText,
  docsInUse,
  doc,
  evNodes,
  evsOfDoc,
  fmt,
  issue,
  line,
  lineNum,
  lines,
  linesCiting,
  consumersOf,
  moneySources,
  nameWords,
  normText,
  num,
  suggest,
  tokensOf,
  uniq,
} from './util.ts';

const moneyByField = (evs: ExtractedValue[]) =>
  new Map(evs.filter((e) => e.value_type === 'money' && typeof e.value === 'number').map((e) => [e.field, e.value as number]));

registerCheck({
  id: 'dup.document',
  title: 'Same document uploaded twice',
  family: 'duplicate',
  run(ctx) {
    const out: CheckIssue[] = [];
    const docs = ctx.b.packet.documents.filter((d) => !d.marked_corrected);
    for (let i = 0; i < docs.length; i++) {
      for (let j = i + 1; j < docs.length; j++) {
        const a = docs[i]!;
        const b = docs[j]!;
        if (a.document_type !== b.document_type || a.tax_year !== b.tax_year) continue;
        const einA = new Set(tokensOf(docText(ctx, a.id), EIN_RE));
        const einB = tokensOf(docText(ctx, b.id), EIN_RE);
        if (!einA.size || !einB.some((x) => einA.has(x))) continue;
        const ma = moneyByField(evsOfDoc(ctx, a.id));
        const mb = moneyByField(evsOfDoc(ctx, b.id));
        const shared = [...ma.keys()].filter((f) => mb.has(f));
        if (shared.length < 3) continue;
        const same = shared.filter((f) => ma.get(f) === mb.get(f));
        if (same.length / shared.length < 0.8) continue;
        const [first, dupe] = a.received_at <= b.received_at ? [a, b] : [b, a];
        const usedA = evsOfDoc(ctx, first.id).flatMap((e) => linesCiting(ctx, e.id));
        const usedB = evsOfDoc(ctx, dupe.id).flatMap((e) => linesCiting(ctx, e.id));
        const doubled = uniq(usedA.filter((k) => usedB.includes(k)));
        out.push(
          issue('dup.document', `${dupe.id}~${first.id}`, {
            code: 'DUPLICATE_DOCUMENT',
            severity: doubled.length ? 'error' : 'info',
            title: doubled.length
              ? `${dupe.id} duplicates ${first.id} and both feed ${doubled.join(', ')}`
              : `${dupe.id} is a second copy of ${first.id}; not used by the return`,
            detail:
              `${dupe.title} and ${first.title} share EIN ${einB.find((x) => einA.has(x))} and ${same.length} of ${shared.length} amounts. ` +
              (doubled.length
                ? 'The same amounts are counted from both documents.'
                : `Only ${first.id} feeds the return. Disposition ${dupe.id} as a duplicate so it is not picked up later.`),
            nodeIds: [`doc:${dupe.id}`, `doc:${first.id}`, ...doubled.map((k) => L(ctx, k))],
          }),
        );
      }
    }
    return out;
  },
});

registerCheck({
  id: 'dup.supersession',
  title: 'Corrected document replaces the original',
  family: 'duplicate',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const c of ctx.b.packet.documents.filter((d) => d.marked_corrected)) {
      const orig = ctx.b.packet.documents.find(
        (d) => d.id !== c.id && !d.marked_corrected && d.issuer === c.issuer && d.document_type === c.document_type && d.tax_year === c.tax_year,
      );
      if (!orig) continue;
      const before = new Map(evsOfDoc(ctx, orig.id).map((e) => [e.field, e]));
      const changes: { from: ExtractedValue; to: ExtractedValue }[] = [];
      for (const e of evsOfDoc(ctx, c.id)) {
        const o = before.get(e.field);
        if (o && JSON.stringify(o.value) !== JSON.stringify(e.value)) changes.push({ from: o, to: e });
      }
      const stale = uniq(evsOfDoc(ctx, orig.id).flatMap((e) => linesCiting(ctx, e.id)));
      const affected = uniq(changes.flatMap((ch) => linesCiting(ctx, ch.to.id)));
      out.push(
        issue('dup.supersession', `${c.id}>${orig.id}`, {
          code: 'CORRECTED_DOCUMENT',
          severity: stale.length ? 'error' : 'info',
          title: stale.length
            ? `${orig.id} was superseded by corrected ${c.id} but still feeds ${stale.length} line(s)`
            : `Corrected ${c.id} replaces ${orig.id}: ${changes.length} value(s) changed`,
          detail:
            `Changes: ${changes.map((ch) => `${ch.to.field} ${String(ch.from.value)} → ${String(ch.to.value)}`).join('; ')}. ` +
            (stale.length
              ? `Lines still citing the original: ${stale.join(', ')}.`
              : `The current version uses ${c.id} for ${affected.join(', ') || 'these lots'}; verify each change against the corrected statement. (§8 E10)`),
          nodeIds: [
            `doc:${c.id}`,
            `doc:${orig.id}`,
            ...changes.flatMap((ch) => [E(ch.from.id), E(ch.to.id)]),
            ...affected.map((k) => L(ctx, k)),
            ...stale.map((k) => L(ctx, k)),
          ],
        }),
      );
    }
    return out;
  },
});

/** Page text without a leading scanner's note such as "(Second scan of ...)". */
const pageBody = (t: string) => normText(t.replace(/^\s*\([^)]*\)\s*/, ''));

registerCheck({
  id: 'dup.page',
  title: 'Duplicate page counted twice',
  family: 'duplicate',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const d of ctx.b.packet.documents) {
      if (d.pages.length < 2) continue;
      const bodies = d.pages.map((p) => pageBody(p.printed_content));
      for (let j = 1; j < d.pages.length; j++) {
        const i = bodies.findIndex((b, k) => k < j && b.length > 40 && b === bodies[j]);
        if (i < 0) continue;
        const orig = d.pages[i]!.page;
        const dupe = d.pages[j]!.page;
        const dupeEvs = evsOfDoc(ctx, d.id).filter((e) => e.page === dupe);
        // Lines that add up values from both the original and the duplicate page.
        const keys = uniq(dupeEvs.flatMap((e) => linesCiting(ctx, e.id)));
        for (const key of keys) {
          const l = line(ctx, key)!;
          const cited = l.sources.map((s) => ctx.b.evs.get(s)).filter((e): e is ExtractedValue => !!e && e.document_id === d.id);
          const fromDupe = cited.filter((e) => e.page === dupe);
          const fromOrig = cited.filter((e) => e.page === orig);
          if (!fromOrig.length) continue;
          const cur = lineNum(ctx, key);
          if (cur === undefined) continue;
          const extra = fromDupe.reduce((s, e) => s + (num(e.value) ?? 0), 0);
          const corrected = cur - extra;
          // Follow to the dollar line when the consumer is this line times an engine parameter.
          const money = dollarConsumer(ctx, key, cur, corrected);
          const target = money ?? { key, value: corrected };
          out.push(
            issue('dup.page', `${d.id}#page${dupe}:${key}`, {
              code: 'DUPLICATE_PAGE',
              severity: 'error',
              title: `${d.id} page ${dupe} repeats page ${orig}; ${l.form} ${l.line} counts it twice`,
              detail:
                `Page ${dupe} of ${d.title} has the same content as page ${orig} ("${d.pages[j]!.printed_content.slice(0, 70)}…"). ` +
                `${key} = ${fmt(cur)} includes ${fmt(extra)} from the duplicate page; corrected ${fmt(corrected)}.` +
                (money ? ` ${money.key} follows: ${fmt(lineNum(ctx, money.key)!)} → ${fmt(money.value)} (${money.how}).` : '') +
                ' (§8 E4)',
              nodeIds: [
                L(ctx, key),
                money && L(ctx, money.key),
                P(d.id, dupe),
                P(d.id, orig),
                ...fromDupe.map((e) => E(e.id)),
                ...fromOrig.map((e) => E(e.id)),
              ],
              ...suggest(ctx, target.key, target.value, `Remove the duplicate page ${dupe} of ${d.id}`),
            }),
          );
        }
      }
    }
    return out;
  },
});

/** A line computed as `input × ref:param.x` (e.g. standard mileage); returns its corrected value. */
function dollarConsumer(ctx: CheckContext, key: string, cur: number, corrected: number) {
  for (const ck of consumersOf(ctx, key)) {
    const c = line(ctx, ck)!;
    if (c.inputs.length !== 1) continue;
    for (const s of c.sources) {
      const m = /^ref:param\.(.+)$/.exec(s);
      if (!m) continue;
      const rate = num(ctx.b.packet.engine_reference.parameters[m[1]!]);
      const cv = lineNum(ctx, ck);
      if (rate === undefined || cv === undefined) continue;
      if (Math.abs(cv - Math.round(cur * rate)) <= 1) {
        return { key: ck, value: Math.round(corrected * rate), how: `${fmt(corrected)} × ${m[1]} ${rate}` };
      }
    }
  }
  return undefined;
}

/** Identifiers a document shares with others: "account ending 7731" style numbers. */
function accountTokens(text: string): Set<string> {
  return new Set([...text.matchAll(/account (?:ending|number ending)\s+(\d{4})/gi)].map((m) => m[1]!));
}

function linked(ctx: CheckContext, a: string, b: string): string | undefined {
  const ta = docText(ctx, a);
  const tb = docText(ctx, b);
  const acct = [...accountTokens(ta)].find((x) => accountTokens(tb).has(x));
  if (acct) return `both cite account ending ${acct}`;
  const da = doc(ctx, a)!;
  const db = doc(ctx, b)!;
  const mentions = (text: string, issuer: string) => {
    const w = nameWords(issuer);
    return w.length >= 2 && normText(text).includes(w.join(' '));
  };
  if (mentions(ta, db.issuer)) return `${a} names ${db.issuer}`;
  if (mentions(tb, da.issuer)) return `${b} names ${da.issuer}`;
  return undefined;
}

registerCheck({
  id: 'dup.cross_line',
  title: 'Same amount reported on two lines from linked documents',
  family: 'duplicate',
  run(ctx) {
    const out: CheckIssue[] = [];
    const used = docsInUse(ctx);
    const cands: { l: ReturnLine; doc: string; evs: ExtractedValue[] }[] = [];
    for (const l of lines(ctx)) {
      if (l.inputs.length || typeof l.value !== 'number' || l.value === 0) continue;
      const evs = moneySources(ctx, l);
      const docs = uniq(evs.map((e) => e.document_id));
      if (docs.length !== 1 || !used.has(docs[0]!)) continue;
      cands.push({ l, doc: docs[0]!, evs });
    }
    for (let i = 0; i < cands.length; i++) {
      for (let j = i + 1; j < cands.length; j++) {
        const a = cands[i]!;
        const b = cands[j]!;
        if (a.doc === b.doc || a.l.rule !== b.l.rule || a.l.form !== b.l.form) continue;
        if (lineNum(ctx, a.l.key) !== lineNum(ctx, b.l.key)) continue;
        const why = linked(ctx, a.doc, b.doc);
        if (!why) continue;
        const amount = lineNum(ctx, b.l.key)!;
        out.push(
          issue('dup.cross_line', `${a.l.key}=${b.l.key}`, {
            code: 'DUPLICATE_AMOUNT',
            severity: 'error',
            title: `${a.l.key} and ${b.l.key} both report ${fmt(amount)} from linked statements`,
            detail:
              `"${a.l.label}" (${a.doc}) and "${b.l.label}" (${b.doc}) carry the same ${fmt(amount)} and the documents are linked: ${why}. ` +
              `This is one payment reported on a composite statement and again on the payer's own form; keep one. (§8 E2)`,
            nodeIds: [L(ctx, a.l.key), L(ctx, b.l.key), ...evNodes(a.evs), ...evNodes(b.evs)],
            ...suggest(ctx, b.l.key, 0, `Already reported on ${a.l.key} (${a.doc})`),
          }),
        );
      }
    }
    return out;
  },
});

registerCheck({
  id: 'dup.within_line',
  title: 'Line adds a statement already included on an information return',
  family: 'duplicate',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const l of lines(ctx)) {
      const evs = moneySources(ctx, l);
      const docs = uniq(evs.map((e) => e.document_id));
      if (docs.length < 2) continue;
      for (const bId of docs) {
        const text = docText(ctx, bId);
        const m = /(?:is|are)\s+(?:reported|included)\s+(?:on|in)\s+the\s+(?:\d{4}\s+)?Form\s+([\w-]+)/i.exec(text);
        if (!m) continue;
        const b = doc(ctx, bId)!;
        const issuerKey = nameWords(b.issuer)[0];
        const aId = docs.find((x) => x !== bId && doc(ctx, x)!.document_type === m[1] && nameWords(doc(ctx, x)!.issuer)[0] === issuerKey);
        if (!aId) continue;
        const dupEvs = evs.filter((e) => e.document_id === bId);
        const extra = dupEvs.reduce((s, e) => s + (num(e.value) ?? 0), 0);
        const cur = lineNum(ctx, l.key);
        if (cur === undefined || !extra) continue;
        const a = doc(ctx, aId)!;
        out.push(
          issue('dup.within_line', `${l.key}:${bId}`, {
            code: 'DOUBLE_COUNTED_COMPONENT',
            severity: 'error',
            title: `${l.form} ${l.line} adds ${fmt(extra)} from ${bId} that is already in ${aId}'s Form ${m[1]}`,
            detail:
              `${b.title} says "${m[0]}". ${l.key} = ${fmt(cur)} sums ${a.title} and ${b.title}, so ${fmt(extra)} is counted twice; corrected ${fmt(cur - extra)}. (§8 E17)`,
            nodeIds: [L(ctx, l.key), `doc:${aId}`, ...evNodes(dupEvs), ...evNodes(evs.filter((e) => e.document_id === aId))],
            ...suggest(ctx, l.key, cur - extra, `${bId} interest is included in ${aId} (Form ${m[1]})`),
          }),
        );
      }
    }
    return out;
  },
});
