// Small shared pieces: status marks, the traceable value, dialogs, error boxes.
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '../state/session';
import type { IssueDto } from '@easetax/shared';
import clsx from 'clsx';
import { AlertTriangle, Cpu, MessageSquare, PenLine, ScanSearch, User, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { errorText } from '../api/client';
import { useDrawer } from '../state/drawer';
import { fmtValue, isMasked } from '../lib/format';

/** The verification mark: an accountant's tick. Amber and struck when the value moved since. */
export function Tick({ stale, size = 14, title }: { stale?: boolean; size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-label={title ?? (stale ? 'Verified, but the value changed since' : 'Verified')} role="img">
      <title>{title ?? (stale ? 'Verified, but the value changed since' : 'Verified')}</title>
      <path d="M2.5 8.6 L6.2 12.2 L13.6 3.2" fill="none" stroke={stale ? '#9A6A10' : '#2E6A4E'} strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
      {stale && <path d="M2 14 L14 2" stroke="#9A6A10" strokeWidth="1.2" />}
    </svg>
  );
}

export function SeverityDot({ severity }: { severity: IssueDto['severity'] | 'blocking' }) {
  return (
    <span
      className={clsx(
        'inline-block h-2 w-2 shrink-0 rounded-full',
        severity === 'error' || severity === 'blocking' ? 'bg-pencil' : severity === 'warning' ? 'bg-amber' : 'bg-faint',
      )}
      aria-label={severity}
    />
  );
}

/** Where an issue came from. Our own checks are shown apart from the engine's diagnostics. */
export function SourceChip({ source }: { source: IssueDto['source'] }) {
  if (source === 'engine')
    return (
      <span className="inline-flex items-center gap-1 rounded border border-rule px-1.5 text-2xs text-graphite" title="Raised by the tax engine's own diagnostics">
        <Cpu size={11} /> Engine
      </span>
    );
  if (source === 'check')
    return (
      <span className="inline-flex items-center gap-1 rounded bg-pencil px-1.5 text-2xs font-semibold text-white" title="Found by an EaseTax check that does not trust engine output">
        <ScanSearch size={11} /> Our check
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 rounded border border-blue px-1.5 text-2xs text-blue-ink" title="Raised by a person">
      <User size={11} /> Raised
    </span>
  );
}

export function Marks({ openIssues, verified, staleVerified, adjusted, notes }: { openIssues?: number; verified?: boolean; staleVerified?: boolean; adjusted?: boolean; notes?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {!!openIssues && (
        <span className="inline-flex items-center gap-0.5 rounded bg-pencil-soft px-1 text-2xs font-semibold text-pencil-ink" title={`${openIssues} open issue(s)`}>
          <AlertTriangle size={10} />
          {openIssues}
        </span>
      )}
      {adjusted && (
        <span className="inline-flex items-center gap-0.5 rounded bg-blue-soft px-1 text-2xs font-semibold text-blue-ink" title="Adjusted in the workpaper">
          <PenLine size={10} /> adj
        </span>
      )}
      {!!notes && (
        <span className="inline-flex items-center gap-0.5 rounded bg-amber-soft px-1 text-2xs font-semibold text-amber-ink" title={`${notes} open review note(s)`}>
          <MessageSquare size={10} />
          {notes}
        </span>
      )}
      {verified && <Tick stale={staleVerified} />}
    </span>
  );
}

/**
 * Every number on screen is one of these: click (or Enter) opens its trace.
 * When adjusted, the original stays visible, struck through.
 */
export function TraceValue({
  nodeId,
  value,
  effective,
  className,
  src,
}: {
  nodeId: string;
  value: unknown;
  effective?: unknown;
  className?: string;
  src?: string;
}) {
  const drawer = useDrawer();
  const adjusted = effective !== undefined && JSON.stringify(effective) !== JSON.stringify(value);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        drawer.open(nodeId, { src });
      }}
      className={clsx('num rounded px-0.5 text-right underline decoration-faint decoration-dotted decoration-1 underline-offset-4 hover:bg-blue-soft hover:text-blue-ink hover:decoration-blue', className)}
      title="Trace this number"
    >
      {adjusted ? (
        <span className="inline-flex items-baseline gap-1.5">
          <span className="text-faint line-through">{fmtValue(value)}</span>
          <span className="font-semibold text-blue-ink">{fmtValue(effective)}</span>
        </span>
      ) : (
        <span className={clsx(isMasked(value) && 'text-graphite')}>{fmtValue(value)}</span>
      )}
    </button>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const { message, rule } = errorText(error);
  const conflict = (error as { body?: { code?: string; details?: { changes?: ConflictChange[] } } })?.body;
  return (
    <div role="alert" className="rounded border border-pencil bg-pencil-soft px-2.5 py-1.5 text-sm text-pencil-ink">
      <div className="font-semibold">{message}</div>
      {rule && rule !== message && <div className="mt-0.5 text-xs">Firm rule: {rule}</div>}
      {conflict?.code === 'conflict' && conflict.details?.changes?.length ? <ConflictChanges changes={conflict.details.changes} /> : null}
    </div>
  );
}

interface ConflictChange {
  seq: number;
  at: string;
  actor: string;
  type: string;
  reason?: string;
  payload: Record<string, unknown>;
}

/** D-57: what someone else changed since you opened this, and a way to load it before retrying. */
function ConflictChanges({ changes }: { changes: ConflictChange[] }) {
  const qc = useQueryClient();
  const { nameOf } = useSession();
  const show = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'number' ? v.toLocaleString('en-US') : String(v));
  return (
    <div className="mt-1.5 text-xs">
      <div className="mb-0.5 font-semibold">What changed:</div>
      <ul className="space-y-0.5">
        {changes.map((c) => {
          const p = c.payload;
          const from = show(p.originalValue);
          const to = show(p.newValue ?? p.correctedValue);
          return (
            <li key={c.seq}>
              {nameOf(c.actor)}, {new Date(c.at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}: {c.type.replace(/\./g, ' ')}
              {to ? ` ${from ? `${from} → ` : ''}${to}` : ''}
              {c.reason ? ` ("${c.reason}")` : ''}
            </li>
          );
        })}
      </ul>
      <button type="button" className="mt-1 font-semibold underline underline-offset-2" onClick={() => void qc.invalidateQueries()}>
        Load the latest, then try again
      </button>
    </div>
  );
}

export function Modal({ title, onClose, children, width = 460 }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('input, textarea, select, button[data-autofocus]');
    el?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-ink/30 pt-[12vh]" data-modal-open="true" onMouseDown={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[76vh] overflow-auto rounded-md border border-rule bg-panel shadow-xl"
        style={{ width: `min(${width}px, 94vw)` }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-rule px-4 py-2.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button className="btn-ghost" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-3 block">
      <span className="mb-1 block text-xs font-semibold text-graphite">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-faint">{hint}</span>}
    </label>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-3 py-6 text-center text-sm text-faint">{children}</div>;
}

export function Loading({ what }: { what?: string }) {
  return <div className="px-3 py-6 text-sm text-faint">Loading{what ? ` ${what}` : ''}…</div>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}
