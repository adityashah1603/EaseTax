// Shared helpers for the engine-independent checks (D-07).
//
// Everything here reads the packet as delivered. Nothing in this module knows the
// expected answer to any finding; it only parses printed text, indexes references
// and builds issues in a consistent shape.

import type { EstimatedEffect, ExtractedValue, PacketDocument, ReturnLine } from '@easetax/shared';
import { estimateEffect, evId, lineId, mapLineToEffect, pageId, resolveRef } from '@easetax/shared';
import type { CheckContext, CheckIssue } from './registry.ts';

// ------------------------------------------------------------------ formatting

export const fmt = (n: number) =>
  n.toLocaleString('en-US', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });

export const r2 = (n: number) => Math.round(n * 100) / 100;

export const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// ------------------------------------------------------------------ printed-text parsing

export interface NumToken {
  value: number;
  index: number;
  raw: string;
}

/** Every number printed in a text: 1,234.56 / 1234 / 0.22 / (800.00). Signs are dropped. */
export function numbersIn(text: string): NumToken[] {
  const out: NumToken[] = [];
  const re = /(?<![\d.,])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g;
  for (const m of text.matchAll(re)) {
    out.push({ value: Number((m[1]! + (m[2] ?? '')).replace(/,/g, '')), index: m.index!, raw: m[0] });
  }
  return out;
}

/** A printed amount such as "41,200.00" or "3,050" (requires a comma group or cents). */
export function parseMoney(raw: string): number {
  return Number(raw.replace(/[$,]/g, ''));
}

/** Every date printed in a text, normalized to ISO (accepts ISO and MM/DD/YYYY). */
export function datesIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) out.add(`${m[1]}-${m[2]}-${m[3]}`);
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g)) {
    out.add(`${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`);
  }
  return out;
}

export function isoFromUs(us: string): string | undefined {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(us.trim());
  return m ? `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}` : undefined;
}

export const EIN_RE = /\b\d{2}-\d{7}\b/g;
export const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;

export const tokensOf = (text: string, re: RegExp) => [...text.matchAll(re)].map((m) => m[0]);

/** Lower-case alphanumerics separated by single spaces. */
export const normText = (s: string) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Damerau-Levenshtein (optimal string alignment) distance; used to explain misreads. */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[a.length]![b.length]!;
}

/** Significant words of a name (drops legal suffixes and filler). */
export function nameWords(s: string): string[] {
  const stop = new Set(['inc', 'llc', 'llp', 'lp', 'co', 'corp', 'n', 'a', 'na', 'the', 'and', 'of', 'iii', 'ii', 'form', 'dba']);
  return normText(s)
    .split(' ')
    .filter((w) => w.length > 1 && !stop.has(w));
}

// ------------------------------------------------------------------ packet access

export function doc(ctx: CheckContext, id: string): PacketDocument | undefined {
  return ctx.b.docs.get(id);
}

export function pageText(ctx: CheckContext, docId: string, page: number): string {
  return ctx.b.docs.get(docId)?.pages.find((p) => p.page === page)?.printed_content ?? '';
}

export function docText(ctx: CheckContext, docId: string): string {
  return (ctx.b.docs.get(docId)?.pages ?? []).map((p) => p.printed_content).join('\n');
}

export function ev(ctx: CheckContext, id: string): ExtractedValue | undefined {
  return ctx.b.evs.get(id.startsWith('ev:') ? id.slice(3) : id);
}

export function lines(ctx: CheckContext): ReturnLine[] {
  return ctx.b.version(ctx.version)?.lines ?? [];
}

export function line(ctx: CheckContext, key: string): ReturnLine | undefined {
  return ctx.b.line(ctx.version, key);
}

/** Effective numeric value of a line (after approved adjustments). */
export function lineNum(ctx: CheckContext, key: string): number | undefined {
  return num(ctx.lineValue(key));
}

export const L = (ctx: CheckContext, key: string) => lineId(ctx.version, key);
export const E = (id: string) => evId(id);
export const P = (doc: string, page: number) => pageId(doc, page);

interface VersionIndex {
  /** raw source ref (ev-0016, qa-14, py:/…) -> keys of lines that cite it */
  bySource: Map<string, string[]>;
  /** line key -> keys of lines that take it as an input */
  byInput: Map<string, string[]>;
}
const indexCache = new WeakMap<object, Map<string, VersionIndex>>();

function versionIndex(ctx: CheckContext): VersionIndex {
  let perBaseline = indexCache.get(ctx.b);
  if (!perBaseline) indexCache.set(ctx.b, (perBaseline = new Map()));
  let idx = perBaseline.get(ctx.version);
  if (idx) return idx;
  idx = { bySource: new Map(), byInput: new Map() };
  for (const l of lines(ctx)) {
    for (const s of l.sources) push(idx.bySource, s, l.key);
    for (const i of l.inputs) push(idx.byInput, i, l.key);
  }
  perBaseline.set(ctx.version, idx);
  return idx;
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V) {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** Keys of current-version lines that cite a raw source reference (e.g. "ev-1045"). */
export function linesCiting(ctx: CheckContext, rawRef: string): string[] {
  return versionIndex(ctx).bySource.get(rawRef) ?? [];
}

/** Keys of current-version lines that take `key` as an input. */
export function consumersOf(ctx: CheckContext, key: string): string[] {
  return versionIndex(ctx).byInput.get(key) ?? [];
}

/** Documents whose values the current version actually uses (documents_used minus superseded). */
export function docsInUse(ctx: CheckContext): Set<string> {
  const v = ctx.b.version(ctx.version);
  if (!v) return new Set();
  const sup = new Set(v.documents_superseded as string[]);
  return new Set(v.documents_used.filter((d) => !sup.has(d)));
}

export function evsOfDoc(ctx: CheckContext, docId: string): ExtractedValue[] {
  return ctx.b.evsByDoc.get(docId) ?? [];
}

/** Money-typed extracted values a line cites. */
export function moneySources(ctx: CheckContext, l: ReturnLine): ExtractedValue[] {
  return l.sources
    .filter((s) => /^ev-\d+$/.test(s))
    .map((s) => ctx.b.evs.get(s)!)
    .filter((e) => e && e.value_type === 'money');
}

export function nodeOfRef(ctx: CheckContext, raw: string): string {
  return resolveRef(raw, ctx.version);
}

/** Pages and documents behind a set of extracted values, for highlighting. */
export function evNodes(evs: ExtractedValue[]): string[] {
  const out: string[] = [];
  for (const e of evs) out.push(evId(e.id), pageId(e.document_id, e.page), `doc:${e.document_id}`);
  return out;
}

export const uniq = <T,>(xs: T[]) => [...new Set(xs)];

// ------------------------------------------------------------------ tax effect

/**
 * Estimated effect of changing `key` from `current` to `suggested`.
 *
 * When the line itself has no rate mapping (e.g. Form 8283 rows) the delta is walked up
 * through R-SUM / R-CARRY consumers until a mapped line is found, so the effect still uses
 * the version's published rates. Form 8949 lots are always walked up to Schedule D: the
 * shared mapping assumes 8949 lots are stored in cents, but the packet stores them in
 * dollars (e.g. F8949.D.X1 = -43.45), so the lot-level scale would understate by 100x.
 */
export function effectOf(ctx: CheckContext, key: string, current: number, suggested: number): EstimatedEffect {
  const v = ctx.b.version(ctx.version)!;
  let k = key;
  for (let i = 0; i < 4; i++) {
    const m = mapLineToEffect(k);
    if (m.kind !== 'none' && !k.startsWith('F8949.')) break;
    const parent = consumersOf(ctx, k).find((p) => {
      const pl = line(ctx, p);
      return pl && (pl.rule === 'R-SUM' || pl.rule === 'R-CARRY');
    });
    if (!parent) break;
    k = parent;
  }
  const e = estimateEffect(k, current, suggested, v.tax_effect_rates, ctx.version);
  if (k !== key && e.estimable) e.basis += ` (carried through ${k})`;
  return e;
}

/** Sum of several effects (e.g. moving a gain from short-term to long-term). */
export function sumEffects(parts: EstimatedEffect[], basis: string): EstimatedEffect {
  const out: EstimatedEffect = {
    estimable: parts.every((p) => p.estimable),
    federalTax: 0,
    californiaTax: 0,
    federalBalance: 0,
    californiaBalance: 0,
    basis,
    warnings: uniq(parts.flatMap((p) => p.warnings)),
  };
  for (const p of parts) {
    out.federalTax = r2(out.federalTax + p.federalTax);
    out.californiaTax = r2(out.californiaTax + p.californiaTax);
    out.federalBalance = r2(out.federalBalance + p.federalBalance);
    out.californiaBalance = r2(out.californiaBalance + p.californiaBalance);
  }
  return out;
}

/** Suggestion + effect for a line whose corrected value a check computed. */
export function suggest(
  ctx: CheckContext,
  key: string,
  suggested: number,
  why: string,
): Pick<CheckIssue, 'suggestion' | 'effect'> {
  const current = lineNum(ctx, key) ?? 0;
  return {
    suggestion: { nodeId: L(ctx, key), value: suggested, why },
    effect: effectOf(ctx, key, current, suggested),
  };
}

// ------------------------------------------------------------------ issues

export function issue(
  checkId: string,
  subject: string,
  i: Omit<CheckIssue, 'id' | 'nodeIds'> & { nodeIds: (string | undefined | false)[] },
): CheckIssue {
  return {
    ...i,
    id: `chk:${checkId}:${subject}`,
    nodeIds: uniq(i.nodeIds.filter((n): n is string => !!n)),
  };
}

/** The household person a document belongs to (taxpayer/spouse/dependent:<id>). */
export function personOfDoc(ctx: CheckContext, d: PacketDocument): string | undefined {
  const people = ctx.b.packet.household.people;
  if (d.belongs_to === 'taxpayer') return people.find((p) => p.role === 'taxpayer')?.id;
  if (d.belongs_to === 'spouse') return people.find((p) => p.role === 'spouse')?.id;
  if (d.belongs_to.startsWith('dependent:')) return d.belongs_to.slice('dependent:'.length);
  return undefined;
}

export const taxYear = (ctx: CheckContext) => ctx.b.packet.household.tax_year;
