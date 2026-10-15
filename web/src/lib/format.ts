// Formatting conventions shared by every screen.
import type { EstimatedEffect } from '@easetax/shared';

const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Numbers as an accountant writes them: thousands separators, negatives in parentheses. */
export function fmtNum(n: number): string {
  const abs = Math.abs(n);
  const s = Number.isInteger(abs) ? nf0.format(abs) : nf2.format(abs);
  return n < 0 ? `(${s})` : s;
}

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') return fmtNum(v);
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v === 'string') return v;
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? s.slice(0, 77) + '…' : s;
  } catch {
    return String(v);
  }
}

export function fmtSigned(n: number): string {
  const r = Math.round(n);
  if (r === 0) return '0';
  return (r > 0 ? '+' : '−') + nf0.format(Math.abs(r));
}

export function fmtDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  // "2026-04-15" is a calendar date. new Date() would read it as midnight UTC, which is the
  // evening of the 14th west of Greenwich (W1); build it in local time instead.
  const ymd = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const d = ymd ? new Date(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])) : new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Estimated effect, always marked ≈ (DECISIONS D-08). */
export function fmtEffect(e: EstimatedEffect | undefined): string {
  if (!e) return '';
  if (!e.estimable) return 'effect not estimable';
  const parts: string[] = [];
  if (e.federalTax) parts.push(`≈ ${fmtSigned(e.federalTax)} fed tax`);
  if (e.californiaTax) parts.push(`≈ ${fmtSigned(e.californiaTax)} CA tax`);
  if (e.federalBalance) parts.push(`≈ ${fmtSigned(e.federalBalance)} fed balance`);
  if (e.californiaBalance) parts.push(`≈ ${fmtSigned(e.californiaBalance)} CA balance`);
  return parts.length ? parts.join(', ') : '≈ no tax effect';
}

export function humanize(s: string): string {
  const t = s.replace(/[_.]/g, ' ').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export interface Variance {
  delta: number;
  pct: number | null;
  flagged: boolean;
}

/** Firm variance rule: flag when the change is over X% and over $Y. */
export function variance(current: unknown, prior: unknown, pctLimit = 10, amtLimit = 1000): Variance | null {
  if (typeof current !== 'number' || typeof prior !== 'number') return null;
  const delta = current - prior;
  const pct = prior === 0 ? null : (delta / Math.abs(prior)) * 100;
  const flagged = Math.abs(delta) > amtLimit && (pct === null || Math.abs(pct) > pctLimit);
  return { delta, pct, flagged };
}

export function isMasked(v: unknown): boolean {
  return typeof v === 'string' && /•|\*\*\*/.test(v);
}

export const NODE_KIND_LABEL: Record<string, string> = {
  line: 'Return line',
  ev: 'Extracted value',
  doc: 'Document',
  page: 'Document page',
  py: 'Prior-year record',
  agency: 'Agency record',
  asset: 'Asset',
  household: 'Person',
  qa: 'Questionnaire answer',
  msg: 'Client message',
  call: 'Call notes',
  ref: 'Engine reference',
  timeline: 'Timeline event',
  version: 'Engine version',
  diag: 'Engine diagnostic',
  att: 'Attachment',
  question: 'Question',
};

export const EDGE_LABEL: Record<string, string> = {
  input_of: 'input',
  sourced_from: 'source',
  read_from: 'read from',
  page_of: 'page of',
  supersedes: 'supersedes',
  duplicate_of: 'duplicate of',
  evidences: 'evidence',
  related: 'linked',
  refers_to: 'refers to',
};
