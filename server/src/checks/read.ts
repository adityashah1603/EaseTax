// Read checks: compare what the pipeline extracted against what is actually printed.
//
// printed_content is ground truth. Each extracted value is normalized by its value_type
// (amounts, dates, EINs, SSNs, text) and looked up among the same-typed tokens printed on
// its page. A plain substring test of text_as_read is useless here (text_as_read echoes the
// extracted value, dates are reformatted, blank boxes read as 0.00), so we compare
// normalized tokens instead and only report values that are genuinely absent.

import type { ExtractedValue } from '@easetax/shared';
import { registerCheck, type CheckContext, type CheckIssue } from './registry.ts';
import {
  E,
  EIN_RE,
  SSN_RE,
  P,
  L,
  datesIn,
  doc,
  docText,
  editDistance,
  fmt,
  issue,
  linesCiting,
  nameWords,
  normText,
  numbersIn,
  pageText,
  tokensOf,
} from './util.ts';

/** Below this confidence a value is routed to the low-confidence check instead. */
export const LOW_CONFIDENCE = 0.7;

interface ReadResult {
  ok: boolean;
  /** Printed tokens of the same type, closest first (for identifiers). */
  candidates?: string[];
}

export function comparePrinted(e: ExtractedValue, text: string): ReadResult {
  const v = e.value;
  if (v === null || v === undefined) return { ok: true };
  switch (e.value_type) {
    case 'money':
    case 'integer':
    case 'quantity': {
      if (typeof v !== 'number') return { ok: true };
      const found = numbersIn(text).some((t) => Math.abs(t.value - Math.abs(v)) < 0.005);
      // A blank box is read as 0.00; that is a correct reading of "nothing printed".
      return { ok: found || v === 0 };
    }
    case 'percent': {
      if (typeof v !== 'number') return { ok: true };
      return { ok: numbersIn(text).some((t) => Math.abs(t.value - v) < 1e-6 || Math.abs(t.value - v * 100) < 1e-6) };
    }
    case 'date': {
      if (typeof v !== 'string') return { ok: true };
      if (/^\d{4}-\d{2}$/.test(v)) return { ok: true }; // month precision; printed as words
      return { ok: datesIn(text).has(v) };
    }
    case 'ein':
    case 'ssn': {
      const toks = tokensOf(text, e.value_type === 'ein' ? EIN_RE : SSN_RE);
      if (toks.includes(String(v))) return { ok: true };
      return { ok: false, candidates: toks.sort((a, b) => editDistance(String(v), a) - editDistance(String(v), b)) };
    }
    case 'text':
    case 'code':
    case 'account_number':
      return { ok: normText(text).includes(normText(String(v))) };
    default:
      return { ok: true };
  }
}

function linesFor(ctx: CheckContext, e: ExtractedValue): string[] {
  return linesCiting(ctx, e.id);
}

registerCheck({
  id: 'read.printed',
  title: 'Extracted value agrees with the printed page',
  family: 'read',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const raw of ctx.b.packet.extracted_values) {
      if (raw.confidence < LOW_CONFIDENCE) continue; // handled by read.low_confidence
      // Compare what the return now rests on: a human correction replaces the pipeline's read.
      const e = ctx.effectiveEv(raw);
      const text = pageText(ctx, e.document_id, e.page);
      if (!text) continue;
      const r = comparePrinted(e, text);
      if (r.ok) continue;
      const d = doc(ctx, e.document_id)!;
      const used = linesFor(ctx, e);
      const best = r.candidates?.[0];
      const dist = best ? editDistance(String(e.value), best) : undefined;
      const how =
        best && dist !== undefined && dist <= 2
          ? `The page prints ${best} (${dist === 1 ? 'one transposition/digit' : `${dist} edits`} away)`
          : best
            ? `The page prints ${r.candidates!.join(', ')}`
            : 'The value does not appear anywhere on the page';
      out.push(
        issue('read.printed', e.id, {
          code: `READ_MISMATCH_${e.value_type.toUpperCase()}`,
          severity: used.length ? 'error' : 'warning',
          title: `Misread ${e.label} on ${d.id}: extracted ${String(e.value)}${best ? `, printed ${best}` : ''}`,
          detail:
            `${d.title}, page ${e.page}: extracted "${String(e.value)}" at confidence ${e.confidence}. ${how}. ` +
            (used.length ? `Used by ${used.join(', ')}; the return carries the misread value. ` : 'Not used by any line. ') +
            '(§8 E14: confident misreads only surface by comparing against printed content.)',
          nodeIds: [E(e.id), P(e.document_id, e.page), `doc:${e.document_id}`, ...used.map((k) => L(ctx, k))],
          // One clear candidate on the page: offer it as the corrected read.
          suggestion:
            best && dist !== undefined && dist <= 2 && r.candidates!.filter((c) => editDistance(String(e.value), c) === dist).length === 1
              ? { nodeId: E(e.id), value: best, why: `The page prints ${best}` }
              : undefined,
        }),
      );
    }
    return out;
  },
});

registerCheck({
  id: 'read.low_confidence',
  title: 'Low-confidence read that feeds the return',
  family: 'read',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const e of ctx.b.packet.extracted_values) {
      if (e.confidence >= LOW_CONFIDENCE || e.value === null) continue;
      // A person has looked at the page and recorded the value: the confidence concern is settled.
      if (ctx.state.correctionFor(e.id)) continue;
      const used = linesFor(ctx, e);
      if (!used.length) continue;
      const d = doc(ctx, e.document_id)!;
      const text = pageText(ctx, e.document_id, e.page);
      const printed = comparePrinted(e, text);
      const ambiguous = /\?/.test(text) ? text.slice(Math.max(0, text.indexOf('?') - 20), text.indexOf('?') + 30) : null;
      // Corroboration: a client message that states the same amount and names the issuer.
      const issuerWords = nameWords(d.issuer).filter((w) => w.length > 3);
      const amount = typeof e.value === 'number' ? fmt(e.value) : String(e.value);
      const corroborating = ctx.b.packet.client.messages.filter(
        (m) => m.text.includes(amount) && issuerWords.some((w) => normText(m.text).includes(w)),
      );
      out.push(
        issue('read.low_confidence', e.id, {
          code: 'LOW_CONFIDENCE_READ',
          severity: 'warning',
          title: `Verify ${e.label} on ${d.id}: read as ${amount} at confidence ${e.confidence}`,
          detail:
            `${d.title}, page ${e.page}. ` +
            (printed.ok ? 'The printed page agrees. ' : `The printed text is ambiguous${ambiguous ? `: "…${ambiguous}…"` : ''}. `) +
            (corroborating.length
              ? `Client message ${corroborating.map((m) => m.id).join(', ')} states ${amount}; record it as evidence before sign-off. `
              : 'No corroborating evidence in file. ') +
            `Feeds ${used.join(', ')}. (§8 E30)`,
          nodeIds: [
            E(e.id),
            P(e.document_id, e.page),
            `doc:${e.document_id}`,
            ...used.map((k) => L(ctx, k)),
            ...corroborating.map((m) => `msg:${m.id}`),
          ],
        }),
      );
    }
    return out;
  },
});

// Identifying text on the return (provider/payer name next to a tax ID) must match the
// document it was taken from. EIN digits are covered by read.printed; this compares names.
registerCheck({
  id: 'read.line_identity',
  title: 'Name on the return matches the source document',
  family: 'read',
  run(ctx) {
    const out: CheckIssue[] = [];
    for (const l of ctx.b.version(ctx.version)?.lines ?? []) {
      const m = /:\s*([^,]+),\s*tax ID\s+(\d{2}-\d{7})/i.exec(l.label);
      if (!m) continue;
      const name = m[1]!.trim();
      const srcDocs = [...new Set(l.sources.map((s) => ctx.b.evs.get(s)?.document_id).filter((x): x is string => !!x))];
      if (!srcDocs.length) continue;
      const printed = srcDocs.map((id) => normText(docText(ctx, id))).join(' ');
      const missing = nameWords(name).filter((w) => !printed.includes(w));
      if (!missing.length) continue;
      const src = doc(ctx, srcDocs[0]!)!;
      out.push(
        issue('read.line_identity', l.key, {
          code: 'LINE_NAME_MISMATCH',
          severity: 'warning',
          title: `${l.form} ${l.line}: "${name}" is not the name printed on ${src.id} ("${src.issuer}")`,
          detail:
            `The return line reads "${l.label}". ${src.title} prints "${src.issuer}"; ` +
            `the word(s) ${missing.map((w) => `"${w}"`).join(', ')} do not appear on it. Correct the provider name before filing. (§8 E14)`,
          nodeIds: [L(ctx, l.key), ...srcDocs.map((d) => `doc:${d}`), ...l.sources.filter((s) => /^ev-/.test(s)).map(E)],
        }),
      );
    }
    return out;
  },
});
