// Building blocks shared by every record screen: traceable cells, findings, flags, checks.
// A record is a review instrument, so the pieces here lean on three ideas: every number
// opens its trace, exceptions are read before detail, and a check shows its verdict.
import type { CellKind, ViewCell, ViewDto, ViewFlag, ViewRow, ViewSection } from '@easetax/shared';
import clsx from 'clsx';
import { AlertTriangle, Check, ChevronDown, ChevronRight, Info, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { fmtNum, fmtValue, isMasked } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { Tick } from '../ui';

// ------------------------------------------------------------------ values

export function num(c: ViewCell | undefined): number | undefined {
  return typeof c?.value === 'number' ? c.value : undefined;
}

export function fmtKind(v: unknown, kind: CellKind = 'money'): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') {
    if (kind === 'percent') return `${Math.abs(v) >= 1000 ? '>999' : v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`;
    if (kind === 'ratio') return v.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
    if (kind === 'cents') return fmtNum(Math.round(v * 100) / 100);
    if (kind === 'money') return fmtNum(Math.abs(v - Math.round(v)) < 0.005 ? Math.round(v) : Math.round(v * 100) / 100);
    return fmtNum(v);
  }
  return fmtValue(v);
}

export const isAdjusted = (c: ViewCell | undefined) =>
  !!c && (c.adjusted || (c.engineValue !== undefined && JSON.stringify(c.engineValue) !== JSON.stringify(c.value)));

/**
 * One number from a view. With a node id it is a button into the trace drawer; when an
 * adjustment is in force the engine's figure stays visible, struck, beside the effective one.
 */
export function Num({ cell, kind = 'money', className, title }: { cell: ViewCell | undefined; kind?: CellKind; className?: string; title?: string }) {
  const drawer = useDrawer();
  if (!cell) return null;
  const adj = isAdjusted(cell);
  const body = adj ? (
    <span className="inline-flex items-baseline gap-1.5" title="Adjusted in the workpaper: engine value struck, effective value in blue">
      <span className="text-faint line-through">{fmtKind(cell.engineValue, kind)}</span>
      <span className="font-semibold text-blue-ink">{fmtKind(cell.value, kind)}</span>
    </span>
  ) : (
    <span className={clsx(isMasked(cell.value) && 'text-graphite')}>{fmtKind(cell.value, kind)}</span>
  );
  if (!cell.nodeId)
    return (
      <span className={clsx('num', className)} title={title ?? cell.note}>
        {body}
      </span>
    );
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        drawer.open(cell.nodeId!);
      }}
      className={clsx('num rounded px-0.5 text-right underline decoration-rule decoration-dotted underline-offset-4 hover:bg-blue-soft hover:decoration-blue', className)}
      title={title ?? cell.note ?? `Trace ${cell.nodeId}`}
    >
      {body}
    </button>
  );
}

/** A plain number we computed on screen (no node behind it), shown as such. */
export function Plain({ value, kind = 'money', className }: { value: unknown; kind?: CellKind; className?: string }) {
  return <span className={clsx('num', className)}>{fmtKind(value, kind)}</span>;
}

export function Signed({ value, className, zeroOk = true }: { value: number | undefined; className?: string; zeroOk?: boolean }) {
  if (value === undefined) return null;
  const r = Math.round(value);
  if (r === 0) return <span className={clsx('num text-faint', className)}>{zeroOk ? '0' : '—'}</span>;
  return (
    <span className={clsx('num', className)}>
      {r > 0 ? '+' : '−'}
      {fmtNum(Math.abs(r))}
    </span>
  );
}

// ------------------------------------------------------------------ node links

const KIND_SHORT: Record<string, string> = { line: '', ev: '', doc: '', qa: 'Q&A ', msg: 'Msg ', call: 'Call ', py: '2024 ', agency: 'Agency ', ref: 'Ref ', asset: 'Asset ', diag: 'Diag ', household: '' };

export function nodeLabel(id: string): string {
  const [kind] = id.split(':', 1);
  const rest = id.slice((kind?.length ?? 0) + 1);
  if (kind === 'line' || kind === 'asset' || kind === 'diag') return (KIND_SHORT[kind] ?? '') + rest.replace(/^v\d+:/, '');
  if (kind === 'py' || kind === 'agency') {
    const parts = rest.split('/').filter(Boolean);
    return (KIND_SHORT[kind] ?? '') + parts.slice(-2).join('/');
  }
  return (KIND_SHORT[kind!] ?? '') + rest.replace('#page', ' p');
}

/** A chip naming any graph node (document, extracted value, client answer, agency record…). */
export function NodeChip({ id, label, className }: { id: string; label?: string; className?: string }) {
  const drawer = useDrawer();
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        drawer.open(id);
      }}
      className={clsx('inline-flex max-w-[220px] items-center truncate rounded border border-rule bg-panel px-1.5 text-2xs text-graphite hover:border-blue hover:text-blue-ink', className)}
      title={`Open ${id}`}
    >
      {label ?? nodeLabel(id)}
    </button>
  );
}

export function NodeChips({ ids, max = 6 }: { ids?: string[]; max?: number }) {
  if (!ids?.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.slice(0, max).map((id) => (
        <NodeChip key={id} id={id} />
      ))}
      {ids.length > max && <span className="text-2xs text-faint">+{ids.length - max}</span>}
    </span>
  );
}

// ------------------------------------------------------------------ flags & findings

export const SEV_RANK: Record<ViewFlag['severity'], number> = { error: 0, warning: 1, info: 2 };

export function worst(flags: ViewFlag[] | undefined): ViewFlag['severity'] | undefined {
  if (!flags?.length) return undefined;
  return [...flags].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0]!.severity;
}

export function SevIcon({ severity, size = 13 }: { severity: ViewFlag['severity']; size?: number }) {
  if (severity === 'error') return <AlertTriangle size={size} className="shrink-0 text-pencil" aria-label="error" />;
  if (severity === 'warning') return <AlertTriangle size={size} className="shrink-0 text-amber" aria-label="warning" />;
  return <Info size={size} className="shrink-0 text-faint" aria-label="info" />;
}

export function FlagText({ flag, chips = true, className }: { flag: ViewFlag; chips?: boolean; className?: string }) {
  return (
    <div className={clsx('flex items-start gap-1.5 text-xs', flag.severity === 'error' ? 'text-pencil-ink' : flag.severity === 'warning' ? 'text-amber-ink' : 'text-graphite', className)}>
      <span className="mt-[1px]">
        <SevIcon severity={flag.severity} size={12} />
      </span>
      <span className="min-w-0">
        {flag.text}
        {chips && flag.nodeIds && flag.nodeIds.length > 0 && (
          <span className="ml-1.5 inline-flex align-middle">
            <NodeChips ids={flag.nodeIds} max={4} />
          </span>
        )}
      </span>
    </div>
  );
}

export function rowTone(flags: ViewFlag[] | undefined) {
  const w = worst(flags);
  return w === 'error' ? 'bg-pencil-soft/50' : w === 'warning' ? 'bg-amber-soft/50' : '';
}

/** The view's exceptions, worst first, before any detail. */
export function Findings({ findings, okText }: { findings: ViewFlag[]; okText?: string }) {
  if (!findings.length)
    return (
      <div className="flex items-center gap-2 rounded border border-ledger/40 bg-ledger-soft px-3 py-2 text-sm text-ledger-ink">
        <Tick /> {okText ?? 'No exceptions from the checks behind this record.'}
      </div>
    );
  const sorted = [...findings].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
  const counts = (['error', 'warning', 'info'] as const).map((s) => [s, findings.filter((f) => f.severity === s).length] as const).filter(([, n]) => n);
  return (
    <section aria-label="Exceptions" className="rounded border border-rule bg-panel">
      <div className="flex items-center gap-3 border-b border-rule px-3 py-1.5">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-graphite">Exceptions first</h2>
        <span className="flex gap-2 text-xs">
          {counts.map(([s, n]) => (
            <span key={s} className={clsx('font-semibold', s === 'error' ? 'text-pencil-ink' : s === 'warning' ? 'text-amber-ink' : 'text-graphite')}>
              {n} {s === 'error' ? 'error' : s}
              {n > 1 ? 's' : ''}
            </span>
          ))}
        </span>
      </div>
      <ul className="divide-y divide-ruleSoft">
        {sorted.map((f, i) => (
          <li key={i} className={clsx('flex items-start gap-2 px-3 py-1.5', f.severity === 'error' && 'border-l-2 border-pencil', f.severity === 'warning' && 'border-l-2 border-amber', f.severity === 'info' && 'border-l-2 border-rule')}>
            <span className="mt-0.5">
              <SevIcon severity={f.severity} />
            </span>
            <div className="min-w-0 flex-1 text-sm">
              <div>{f.text}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-2">
                <code className="text-2xs text-faint">{f.code}</code>
                <NodeChips ids={f.nodeIds} max={8} />
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

// ------------------------------------------------------------------ verdicts & pills

export function Verdict({ ok, children, warn }: { ok: boolean; children?: ReactNode; warn?: boolean }) {
  return (
    <span className={clsx('inline-flex items-center gap-1 text-xs font-semibold', ok ? 'text-ledger-ink' : warn ? 'text-amber-ink' : 'text-pencil-ink')}>
      {ok ? <Check size={13} /> : warn ? <AlertTriangle size={12} /> : <X size={13} />}
      {children}
    </span>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'adj' | 'none';
export function Pill({ tone = 'none', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 text-2xs font-semibold',
        tone === 'ok' && 'bg-ledger-soft text-ledger-ink',
        tone === 'warn' && 'bg-amber-soft text-amber-ink',
        tone === 'bad' && 'bg-pencil-soft text-pencil-ink',
        tone === 'info' && 'bg-ruleSoft text-graphite',
        tone === 'adj' && 'bg-blue-soft text-blue-ink',
        tone === 'none' && 'border border-rule text-graphite',
      )}
    >
      {children}
    </span>
  );
}

export const AdjPill = () => (
  <Pill tone="adj" title="An approved workpaper adjustment is in force on this number">
    adjusted
  </Pill>
);

// ------------------------------------------------------------------ layout

export function Box({ title, note, right, children, className, id, pad = false }: { title?: ReactNode; note?: ReactNode; right?: ReactNode; children: ReactNode; className?: string; id?: string; pad?: boolean }) {
  return (
    <section id={id} className={clsx('rounded border border-rule bg-panel', className)}>
      {(title || right) && (
        <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-rule px-3 py-2">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {note && <span className="text-xs text-graphite">{note}</span>}
          <span className="flex-1" />
          {right}
        </header>
      )}
      <div className={clsx(pad && 'p-3')}>{children}</div>
    </section>
  );
}

export function Collapsible({ title, children, defaultOpen = false, right }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; right?: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs font-semibold text-graphite hover:bg-paper" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {title}
        <span className="flex-1" />
        {right}
      </button>
      {open && children}
    </div>
  );
}

export function Stat({ label, children, tone }: { label: string; children: ReactNode; tone?: Tone }) {
  return (
    <div className={clsx('rounded border px-3 py-2', tone === 'bad' ? 'border-pencil/50 bg-pencil-soft/40' : tone === 'warn' ? 'border-amber/50 bg-amber-soft/40' : tone === 'ok' ? 'border-ledger/40 bg-ledger-soft/40' : 'border-rule bg-panel')}>
      <div className="text-2xs font-semibold uppercase tracking-wide text-graphite">{label}</div>
      <div className="mt-0.5 text-lg font-semibold leading-tight">{children}</div>
    </div>
  );
}

// ------------------------------------------------------------------ generic section

/** Fallback for any section a dedicated renderer does not know: still traceable, flags inline. */
export function GenericSection({ section, title }: { section: ViewSection; title?: ReactNode }) {
  const cols = section.columns;
  const drawer = useDrawer();
  const textCols = new Set(cols.filter((c) => c.kind === 'text' || c.kind === 'status' || c.kind === 'date').map((c) => c.key));
  const row = (r: ViewRow, total = false) => (
    <tr
      key={(total ? 't:' : '') + r.id}
      className={clsx('border-b border-ruleSoft align-top last:border-0', rowTone(r.flags), total && 'border-t border-rule font-semibold', r.nodeId && 'cursor-pointer hover:bg-paper')}
      onClick={() => r.nodeId && drawer.open(r.nodeId)}
    >
      <td className="px-3 py-1.5">
        <div>{r.label}</div>
        {r.sublabel && <div className="text-xs text-faint">{r.sublabel}</div>}
        {r.flags?.map((f, i) => <FlagText key={i} flag={f} className="mt-0.5" />)}
      </td>
      {r.status !== undefined && cols.every((c) => c.kind !== 'status') && <td className="px-2 py-1.5 text-xs text-graphite">{r.status}</td>}
      {cols.map((c) => (
        <td key={c.key} className={clsx('px-2 py-1.5', textCols.has(c.key) ? 'text-left text-xs text-graphite' : 'text-right')}>
          <Num cell={r.cells[c.key]} kind={c.kind} />
        </td>
      ))}
    </tr>
  );
  const hasStatus = section.rows.some((r) => r.status !== undefined) && cols.every((c) => c.kind !== 'status');
  return (
    <Box title={title ?? section.title} note={section.note}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-rule text-xs text-graphite">
              <th className="px-3 py-1.5 text-left font-semibold" />
              {hasStatus && <th className="px-2 py-1.5 text-left font-semibold">Status</th>}
              {cols.map((c) => (
                <th key={c.key} className={clsx('px-2 py-1.5 font-semibold', textCols.has(c.key) ? 'text-left' : 'text-right')}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {section.rows.map((r) => row(r))}
            {section.totals?.map((r) => row(r, true))}
          </tbody>
        </table>
      </div>
    </Box>
  );
}

/** Sections by id, plus whatever a dedicated renderer did not claim (rendered generically). */
export function sectionsOf(view: ViewDto) {
  const byId = new Map(view.sections.map((s) => [s.id, s]));
  const rest = (claimed: string[]) => view.sections.filter((s) => !claimed.includes(s.id));
  return { get: (id: string) => byId.get(id), rest };
}

export function Rest({ sections }: { sections: ViewSection[] }) {
  return (
    <>
      {sections.map((s) => (
        <GenericSection key={s.id} section={s} />
      ))}
    </>
  );
}

export function flagsIn(rows: ViewRow[] | undefined): ViewFlag[] {
  return (rows ?? []).flatMap((r) => r.flags ?? []);
}
