// Small pieces shared by the filing, firm and changes screens.
import type { Role, WorkEvent } from '@easetax/shared';
import clsx from 'clsx';
import { useState, type ReactNode } from 'react';
import { getActor } from '../../api/client';
import { useInvalidateAll } from '../../api/hooks';
import { fmtValue, humanize } from '../../lib/format';
import { useSession } from '../../state/session';
import { useToast } from '../../state/toast';

export function Panel({ title, sub, right, children, id }: { title: string; sub?: ReactNode; right?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <section id={id} className="mb-5 scroll-mt-4 rounded border border-rule bg-panel">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-ruleSoft px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">{title}</h2>
          {sub && <div className="mt-0.5 text-xs text-graphite">{sub}</div>}
        </div>
        {right && <div className="flex shrink-0 flex-wrap items-center gap-2">{right}</div>}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

/** A content hash: short on screen, full on hover and when selected/copied. */
export function Hash({ value, label }: { value: string | undefined; label?: string }) {
  if (!value) return <span className="text-faint">—</span>;
  return (
    <code className="rounded bg-paper px-1 font-mono text-2xs text-graphite" title={`${label ?? 'SHA-256'} ${value}`}>
      {value.slice(0, 12)}…{value.slice(-4)}
    </code>
  );
}

export type Tone = 'ok' | 'bad' | 'warn' | 'neutral' | 'info';
export function Pill({ tone, children, title }: { tone: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 text-2xs font-semibold',
        tone === 'ok' && 'bg-ledger-soft text-ledger-ink',
        tone === 'bad' && 'bg-pencil-soft text-pencil-ink',
        tone === 'warn' && 'bg-amber-soft text-amber-ink',
        tone === 'info' && 'bg-blue-soft text-blue-ink',
        tone === 'neutral' && 'bg-ruleSoft text-graphite',
      )}
    >
      {children}
    </span>
  );
}

/** Run one write, refresh every query, confirm with a toast; the error stays on screen until the next try. */
export function useAction() {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const run = async <T,>(key: string, fn: () => Promise<T>, done?: string | ((r: T) => string)): Promise<T | undefined> => {
    setBusy(key);
    setError(null);
    try {
      const r = await fn();
      invalidate();
      if (done) toast.push({ tone: 'ok', text: typeof done === 'string' ? done : done(r) });
      return r;
    } catch (e) {
      setError(e);
      toast.error(e);
      return undefined;
    } finally {
      setBusy(null);
    }
  };
  return { run, busy, error, clearError: () => setError(null) };
}

/** Whether the acting role may do something, with the reason to show when it may not. */
export function useRoleGate(roles: Role[], what: string): { allowed: boolean; why?: string } {
  const { actor } = useSession();
  const allowed = !!actor && roles.includes(actor.role);
  return { allowed, why: allowed ? undefined : `${humanize(actor?.role ?? 'this role')} can't ${what}; ${roles.map((r) => humanize(r).toLowerCase()).join(' or ')} only.` };
}

/** Fetch a file as the acting user (X-Actor) and open or save it, so exports are never anonymous. */
export async function fetchAsActor(path: string): Promise<Blob> {
  const res = await fetch(path, { headers: { 'x-actor': getActor() } });
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      msg = ((await res.json()) as { error?: string }).error ?? msg;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return res.blob();
}

export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function openBlob(blob: Blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Node ids an event touches, for grouping "what changed" by item. */
export function eventNodes(e: WorkEvent): string[] {
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  if (typeof p.nodeId === 'string') out.push(p.nodeId);
  if (Array.isArray(p.nodeIds)) out.push(...(p.nodeIds as string[]));
  if (typeof p.documentId === 'string') out.push(`doc:${p.documentId}`);
  if (typeof p.from === 'string' && typeof p.to === 'string') out.push(p.from as string);
  if (typeof p.evidenceId === 'string' && !out.length) out.push(p.evidenceId);
  return [...new Set(out)];
}

const EVENT_TEXT: Record<string, string> = {
  'verification.added': 'verified',
  'verification.removed': 'removed a verification',
  'adjustment.proposed': 'proposed an adjustment',
  'adjustment.approved': 'approved an adjustment',
  'adjustment.rejected': 'rejected an adjustment',
  'adjustment.reverted': 'reverted an adjustment',
  'issue.resolved': 'resolved an issue',
  'issue.closure_confirmed': 'confirmed an issue closure',
  'issue.reopened': 'reopened an issue',
  'issue.raised': 'raised an issue',
  'note.created': 'wrote a review note',
  'note.replied': 'replied to a note',
  'note.resolved': 'cleared a review note',
  'note.reopened': 'reopened a review note',
  'question.asked': 'asked a question',
  'question.answered': 'answered a question',
  'question.closed': 'closed a question',
  'attachment.added': 'attached a file',
  'evidence.linked': 'linked evidence',
  'link.created': 'linked two items',
  'judgment.recorded': 'recorded a judgment',
  'disposition.set': 'set a document disposition',
  'area.considered': 'marked an area considered',
  'variance.explained': 'explained a variance',
  'reconciliation.explained': 'explained a reconciliation',
  'signoff.recorded': 'signed off',
  'signoff.reopened': 'sign-off reopened',
  'signoff.withdrawn': 'withdrew a sign-off',
  'assignment.created': 'assigned work',
  'assignment.completed': 'completed an assignment',
  'time.logged': 'logged time',
  'sensitive.unmasked': 'viewed a sensitive field',
  'firm.standards_updated': 'changed the firm standards',
  'events.undone': 'undid an action',
  'filing.step': 'filing step',
};

/** One-line description of an event: "verified (agreed to source document)". */
export function describeEvent(e: WorkEvent): string {
  const p = (e.payload ?? {}) as Record<string, any>;
  const base = EVENT_TEXT[e.type] ?? humanize(e.type);
  switch (e.type) {
    case 'verification.added':
      return `${base} (${humanize(String(p.type)).toLowerCase()})`;
    case 'adjustment.proposed':
      return `${base}: ${fmtValue(p.originalValue)} to ${fmtValue(p.newValue)}${p.requiresPartner ? ', needs a partner' : ''}`;
    case 'disposition.set':
      return `${base}: ${humanize(String(p.status)).toLowerCase()}`;
    case 'signoff.recorded':
      return `${base} as ${p.level} on ${p.scope === 'return' ? 'the whole return' : p.scope}`;
    case 'filing.step':
      return `filing: ${humanize(String(p.step)).toLowerCase()}`;
    case 'time.logged':
      return `${base}: ${p.hours} h on ${humanize(String(p.area)).toLowerCase()}`;
    case 'note.created':
    case 'question.asked':
    case 'note.replied':
    case 'question.answered':
      return `${base}: “${String(p.text ?? '').slice(0, 90)}”`;
    case 'issue.resolved':
      return `${p.status === 'accepted' ? 'accepted an issue as is' : base}`;
    default:
      return base;
  }
}
