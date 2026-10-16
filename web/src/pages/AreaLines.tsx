// One review area: its lines (virtualized; Form 8949 alone has ~300 lots), prior-year
// variance per the firm rule, bulk verification, and the area's sign-off panel.
import type { LineRow } from '@easetax/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import { ArrowLeft } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAdjustments, useAreas, useLines, useStandards } from '../api/hooks';
import { VerifyDialog } from '../components/actions';
import { SignoffPanel } from '../components/SignoffPanel';
import { AreaConsidered } from '../components/workflow/AreaConsidered';
import { Empty, Kbd, Loading, Marks, TraceValue } from '../components/ui';
import { fmtValue, variance } from '../lib/format';
import { useListNav } from '../lib/useListNav';
import { useDrawer } from '../state/drawer';
import { useSession } from '../state/session';

type Row = { type: 'head'; form: string; count: number } | { type: 'line'; line: LineRow; i: number };

export function AreaLines() {
  const { areaId } = useParams();
  const areas = useAreas();
  const area = areas.data?.find((a) => a.id === areaId);
  const lines = useLines(areaId);
  const std = useStandards();
  const vr = std.data?.variance_review;
  // Adjustments over the firm limit wait here for a partner; mark their lines.
  const proposed = useAdjustments('proposed');
  const awaitingPartner = useMemo(() => new Set((proposed.data ?? []).map((a) => a.nodeId)), [proposed.data]);
  const drawer = useDrawer();
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [exceptions, setExceptions] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [bulkVerify, setBulkVerify] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (lines.data ?? []).filter((l) => {
      if (needle && !`${l.key} ${l.label} ${l.rule}`.toLowerCase().includes(needle)) return false;
      if (exceptions) {
        const v = variance(l.effectiveValue, l.priorYear, vr?.flag_if_change_over_percent, vr?.and_over_amount);
        return l.openIssues > 0 || l.adjusted || l.notes > 0 || !!v?.flagged || awaitingPartner.has(l.id);
      }
      return true;
    });
  }, [lines.data, q, exceptions, vr, awaitingPartner]);

  // Interleave form headers so a 300-lot form still reads as sections.
  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    let form = '';
    const counts = new Map<string, number>();
    for (const l of filtered) counts.set(l.form, (counts.get(l.form) ?? 0) + 1);
    filtered.forEach((l, i) => {
      if (l.form !== form) {
        form = l.form;
        out.push({ type: 'head', form, count: counts.get(form)! });
      }
      out.push({ type: 'line', line: l, i });
    });
    return out;
  }, [filtered]);
  const rowIndexOfLine = useMemo(() => {
    const m: number[] = [];
    rows.forEach((r, ri) => r.type === 'line' && (m[r.i] = ri));
    return m;
  }, [rows]);

  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: (i) => (rows[i]?.type === 'head' ? 30 : 34),
    overscan: 12,
  });

  const toggle = (i: number, range = false) => {
    const l = filtered[i];
    if (!l) return;
    setSelected((s) => {
      const n = new Set(s);
      if (range && anchor !== null) {
        const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
        for (let k = a; k <= b; k++) n.add(filtered[k]!.id);
      } else if (n.has(l.id)) n.delete(l.id);
      else n.add(l.id);
      return n;
    });
    setAnchor(i);
  };

  const [cursor, setCursor] = useListNav(
    filtered.length,
    {
    Enter: () => filtered[cursor] && drawer.open(filtered[cursor]!.id),
    v: () => {
      if (selected.size > 0) setBulkVerify(true);
      else if (filtered[cursor]) drawer.open(filtered[cursor]!.id, { act: 'verify' });
    },
    a: () => filtered[cursor] && drawer.open(filtered[cursor]!.id, { act: 'adjust' }),
    n: () => filtered[cursor] && drawer.open(filtered[cursor]!.id, { act: 'note' }),
    x: () => toggle(cursor),
    },
    (i) => virt.scrollToIndex(rowIndexOfLine[i] ?? 0, { align: 'auto' }),
  );

  if (!areaId) return null;
  const sel = [...selected].filter((id) => filtered.some((l) => l.id === id));

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-rule bg-panel px-6 pb-3 pt-4">
        <Link to="/map" className="btn-ghost -ml-1.5 mb-1 text-xs">
          <ArrowLeft size={12} /> Return map
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="font-serif text-2xl font-semibold">{area?.title ?? areaId}</h1>
            {area && (
              <p className="num text-sm text-graphite">
                {area.verifiedLines} of {area.lineCount} lines verified · {area.openIssues} open issues · {area.adjustedLines} adjusted · {area.loggedHours}
                {area.budgetHours !== undefined ? ` of ${area.budgetHours}` : ''} hours
              </p>
            )}
            {area && <AreaConsidered area={area} />}
          </div>
          <div className="w-full max-w-[520px]">
            <SignoffPanel scope={`area:${areaId}`} compact />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input className="input max-w-[280px]" placeholder="Filter lines, e.g. 8949 or Meridian" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter lines" />
          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={exceptions} onChange={(e) => setExceptions(e.target.checked)} />
            Exceptions only
            <span className="text-xs text-faint">(issues, adjusted or awaiting partner, notes, variance over threshold)</span>
          </label>
          <span className="flex-1" />
          {sel.length > 0 && can('verify') && (
            <span className="flex items-center gap-2 text-sm">
              <span className="font-semibold">{sel.length} selected</span>
              <button className="btn-primary" onClick={() => setBulkVerify(true)}>
                Verify {sel.length}
              </button>
              <button className="btn-ghost" onClick={() => setSelected(new Set())}>
                Clear
              </button>
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-[28px_120px_minmax(0,1fr)_120px_130px_120px_110px] items-center gap-2 border-b border-rule bg-paper px-6 py-1.5 text-xs font-semibold text-graphite">
        <span />
        <span>Line</span>
        <span>Description</span>
        <span />
        <span className="text-right">2025 (v3)</span>
        <span className="text-right">2024</span>
        <span className="text-right">Change</span>
      </div>

      {lines.isLoading ? (
        <Loading what="lines" />
      ) : filtered.length === 0 ? (
        <Empty>{exceptions ? 'No exceptions in this area. Turn off “Exceptions only” to see every line.' : 'No lines match this filter.'}</Empty>
      ) : (
        <div ref={scroller} className="min-h-0 flex-1 overflow-auto bg-panel" role="listbox" aria-label="Lines" aria-multiselectable>
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((vi) => {
              const r = rows[vi.index]!;
              const style = { position: 'absolute' as const, top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${vi.start}px)` };
              if (r.type === 'head')
                return (
                  <div key={vi.key} style={style} className="flex items-end border-b border-rule bg-panel px-6 pb-1 text-xs font-semibold text-graphite">
                    {r.form} <span className="ml-1.5 font-normal text-faint">{r.count} lines</span>
                  </div>
                );
              const l = r.line;
              const v = variance(l.effectiveValue, l.priorYear, vr?.flag_if_change_over_percent, vr?.and_over_amount);
              const isSel = selected.has(l.id);
              return (
                <div
                  key={vi.key}
                  style={style}
                  role="option"
                  aria-selected={r.i === cursor}
                  className={clsx(
                    'grid cursor-pointer grid-cols-[28px_120px_minmax(0,1fr)_120px_130px_120px_110px] items-center gap-2 border-b border-ruleSoft px-6 text-sm',
                    r.i === cursor ? 'bg-blue-soft' : isSel ? 'bg-ledger-soft/60' : 'hover:bg-paper',
                  )}
                  onClick={(e) => {
                    setCursor(r.i);
                    if (e.shiftKey) toggle(r.i, true);
                    else drawer.open(l.id);
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSel}
                    aria-label={`Select ${l.key}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(r.i, e.shiftKey);
                    }}
                    onChange={() => undefined}
                  />
                  <span className="truncate text-xs text-graphite" title={l.rule}>
                    {l.form} {l.line}
                    {l.jurisdiction === 'california' && ' · CA'}
                  </span>
                  <span className="truncate" title={l.label}>
                    {l.label}
                  </span>
                  <span className="flex items-center justify-end gap-1.5">
                    {awaitingPartner.has(l.id) && (
                      <span className="rounded bg-amber-soft px-1 text-2xs font-semibold text-amber-ink" title="An adjustment to this line waits for partner approval and is not in force yet">
                        partner
                      </span>
                    )}
                    <Marks openIssues={l.openIssues} verified={l.verified} adjusted={l.adjusted} notes={l.notes} />
                  </span>
                  <span className="text-right">
                    <TraceValue nodeId={l.id} value={l.value} effective={l.effectiveValue} />
                  </span>
                  <span className="num text-right text-graphite">{l.priorYear === undefined ? '' : fmtValue(l.priorYear)}</span>
                  <span className={clsx('num text-right text-xs', v?.flagged ? 'rounded bg-amber-soft px-1 font-semibold text-amber-ink' : 'text-faint')} title={v?.flagged ? 'Over the firm variance threshold: explain this change' : undefined}>
                    {v && v.delta !== 0 ? `${v.delta > 0 ? '+' : '−'}${fmtValue(Math.abs(v.delta))}${v.pct !== null ? ` ${Math.abs(v.pct) >= 1000 ? '>999' : Math.round(v.pct)}%` : ''}` : ''}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="border-t border-rule bg-paper px-6 py-1 text-2xs text-faint">
        <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>Enter</Kbd> trace · <Kbd>x</Kbd> or shift-click select · <Kbd>v</Kbd> verify (selection or line) · <Kbd>a</Kbd> adjust · <Kbd>n</Kbd> note
      </div>
      {bulkVerify && sel.length > 0 && <VerifyDialog nodeIds={sel} revisions={Object.fromEntries((lines.data ?? []).filter((l) => sel.includes(l.id)).map((l) => [l.id, l.revision]))} label={`${sel.length} lines in ${area?.title ?? areaId}`} onClose={() => (setBulkVerify(false), setSelected(new Set()))} />}
    </div>
  );
}
