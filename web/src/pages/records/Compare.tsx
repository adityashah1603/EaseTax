// Version compare: v1 ↔ v2 ↔ v3 ↔ the workpaper, line by line and grouped by form, with
// each difference attributed to its cause — an engine recompute (with the trigger the engine
// recorded) or one of our approved adjustments. Every row opens the trace drawer.
import { lineId } from '@easetax/shared';
import clsx from 'clsx';
import { ArrowRight, ChevronDown, ChevronRight, Cpu, PenLine } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useSummary } from '../../api/hooks';
import { useAdjustments, useCompare, useEngineChanges, useVersionLines, type LineDiff } from '../../api/recordsHooks';
import { Num, Pill, Signed } from '../../components/records/kit';
import { ErrorBox, Loading } from '../../components/ui';
import { useDrawer } from '../../state/drawer';

type Cause = 'engine' | 'ours';
interface Row {
  d: LineDiff;
  form: string;
  causes: Cause[];
  steps: string[];
  engineB: unknown;
  reason?: string;
  order: number;
}

const kindOf = (v: unknown) => (typeof v === 'number' && !Number.isInteger(v) && Math.abs(v) < 10 ? 'ratio' : typeof v === 'number' ? 'money' : 'text');
const vnum = (v: string) => Number(v.replace(/\D/g, '')) || 0;

export function Compare() {
  const summary = useSummary();
  const cur = summary.data?.currentVersion ?? 'v3';
  const versions = summary.data?.versions.map((v) => v.version) ?? ['v1', 'v2', 'v3'];
  const [params, setParams] = useSearchParams();
  const a = params.get('a') ?? (versions.length > 1 ? versions[versions.length - 2]! : 'v1');
  const b = params.get('b') ?? cur;
  const set = (k: 'a' | 'b', v: string) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        n.set(k, v);
        return n;
      },
      { replace: true },
    );

  const cmp = useCompare(a, b);
  const linesA = useVersionLines(a);
  const linesB = useVersionLines(b);
  const adjustments = useAdjustments();
  // Engine changes for every step between a and b (the endpoint only returns b's own).
  const [lo, hi] = vnum(a) <= vnum(b) ? [a, b] : [b, a];
  const steps = versions.filter((v) => vnum(v) > vnum(lo) && vnum(v) <= vnum(hi));
  const eng = useEngineChanges(steps);
  const triggers = new Map(summary.data?.versions.map((v) => [v.version, v.trigger]) ?? []);

  const [q, setQ] = useState('');
  const [only, setOnly] = useState<'all' | Cause>('all');
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const drawer = useDrawer();

  const rows = useMemo<Row[]>(() => {
    if (!cmp.data) return [];
    const bRows = new Map((linesB.data ?? []).map((l, i) => [l.key, { l, i }]));
    const aRows = new Map((linesA.data ?? []).map((l, i) => [l.key, { l, i }]));
    const adjByKey = new Map((adjustments.data ?? []).filter((x) => x.status === 'approved').map((x) => [x.nodeId, x]));
    return cmp.data.diffs.map((d) => {
      const lb = bRows.get(d.key);
      const la = aRows.get(d.key);
      const engineB = lb ? lb.l.value : d.b;
      const causes: Cause[] = [];
      if (JSON.stringify(d.a) !== JSON.stringify(engineB) || d.change !== 'changed') causes.push('engine');
      if (b === cur && d.adjusted && JSON.stringify(engineB) !== JSON.stringify(d.b)) causes.push('ours');
      const stepHits = steps.filter((v) => eng.byVersion.get(v)?.some((c) => c.key === d.key));
      return {
        d,
        form: lb?.l.form ?? la?.l.form ?? d.key.split('.')[0]!,
        causes: causes.length ? causes : ['engine'],
        steps: stepHits,
        engineB,
        reason: adjByKey.get(lineId(cur, d.key))?.reason,
        order: lb?.i ?? la?.i ?? 99999,
      };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmp.data, linesA.data, linesB.data, adjustments.data, eng.byVersion.size, b, cur]);

  const filtered = rows.filter((r) => (only === 'all' || r.causes.includes(only)) && (!q.trim() || `${r.d.key} ${r.d.label}`.toLowerCase().includes(q.trim().toLowerCase())));
  const forms = useMemo(() => {
    const m = new Map<string, Row[]>();
    for (const r of [...filtered].sort((x, y) => x.order - y.order)) m.set(r.form, [...(m.get(r.form) ?? []), r]);
    return [...m.entries()];
  }, [filtered]);
  const nEngine = rows.filter((r) => r.causes.includes('engine')).length;
  const nOurs = rows.filter((r) => r.causes.includes('ours')).length;
  const bLabel = (v: string) => (v === cur ? `${v} + workpaper adjustments (current)` : `engine ${v}`);
  const sameEngine = a === b;

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-5">
      <h1 className="mb-1 font-serif text-2xl font-semibold">Compare versions</h1>
      <p className="mb-3 text-sm text-graphite">Line-by-line differences between engine runs and the current workpaper, grouped by form. Each difference says what caused it.</p>

      <div className="mb-3 flex flex-wrap items-end gap-3 rounded border border-rule bg-panel px-3 py-2.5">
        <label className="text-xs font-semibold text-graphite">
          From
          <select className="input mt-0.5 block w-[150px]" value={a} onChange={(e) => set('a', e.target.value)}>
            {versions.map((v) => (
              <option key={v} value={v}>
                engine {v}
              </option>
            ))}
          </select>
        </label>
        <ArrowRight size={16} className="mb-2 text-faint" />
        <label className="text-xs font-semibold text-graphite">
          To
          <select className="input mt-0.5 block w-[300px]" value={b} onChange={(e) => set('b', e.target.value)}>
            {versions.map((v) => (
              <option key={v} value={v}>
                {bLabel(v)}
              </option>
            ))}
          </select>
        </label>
        <span className="flex-1" />
        <div className="flex flex-wrap gap-1.5 text-xs">
          {[
            ['v1', 'v2'],
            ['v2', cur],
            [cur, cur],
          ].map(([x, y]) => (
            <button key={`${x}${y}`} className={clsx('rounded border px-2 py-0.5', a === x && b === y ? 'border-ink bg-ink text-white' : 'border-rule hover:border-graphite')} onClick={() => (set('a', x!), set('b', y!))}>
              {x === y ? `engine ${x} → workpaper` : `${x} → ${y}`}
            </button>
          ))}
        </div>
      </div>

      {steps.length > 0 && (
        <ol className="mb-3 space-y-1 text-sm">
          {steps.map((v) => (
            <li key={v} className="flex items-start gap-2">
              <Pill tone="info">
                <Cpu size={10} /> {vnum(a) <= vnum(b) ? '' : 'undo '}
                {v}
              </Pill>
              <span className="text-graphite">{triggers.get(v) ?? 'Engine recompute.'}</span>
              <span className="text-xs text-faint">{eng.byVersion.get(v)?.length ?? '…'} engine line changes</span>
            </li>
          ))}
        </ol>
      )}
      {sameEngine && b === cur && <p className="mb-3 text-sm text-graphite">Same engine run on both sides: the differences below are our approved workpaper adjustments only.</p>}
      {sameEngine && b !== cur && <p className="mb-3 text-sm text-graphite">Pick two different versions, or the current version on the right to see workpaper adjustments.</p>}

      <ErrorBox error={cmp.error ?? eng.error} />
      {cmp.isLoading ? (
        <Loading what="differences" />
      ) : (
        cmp.data && (
          <>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <span className="text-sm">
                <span className="font-semibold">{rows.length}</span> line(s) differ across <span className="font-semibold">{new Set(rows.map((r) => r.form)).size}</span> forms
              </span>
              <span className="flex gap-1 text-xs" role="tablist" aria-label="Filter by cause">
                {(
                  [
                    ['all', `All ${rows.length}`],
                    ['engine', `Engine ${nEngine}`],
                    ['ours', `Our adjustments ${nOurs}`],
                  ] as const
                ).map(([k, t]) => (
                  <button key={k} role="tab" aria-selected={only === k} className={clsx('rounded border px-2 py-0.5', only === k ? 'border-ink bg-ink text-white' : 'border-rule hover:border-graphite')} onClick={() => setOnly(k)}>
                    {t}
                  </button>
                ))}
              </span>
              <span className="flex-1" />
              <input className="input w-[220px]" placeholder="Filter lines" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter lines" />
            </div>
            <div className="rounded border border-rule bg-panel">
              <div className="grid grid-cols-[110px_minmax(0,1fr)_110px_20px_150px_100px_minmax(150px,240px)] gap-2 border-b border-rule px-3 py-1.5 text-xs font-semibold text-graphite">
                <span>Line</span>
                <span>Description</span>
                <span className="text-right">{a}</span>
                <span />
                <span className="text-right">{b === cur ? `${b} → effective` : b}</span>
                <span className="text-right">Δ</span>
                <span>Cause</span>
              </div>
              {forms.length === 0 && <div className="px-3 py-6 text-center text-sm text-faint">No differences{only !== 'all' || q ? ' match this filter' : ''}.</div>}
              {forms.map(([form, rs]) => {
                const isClosed = closed.has(form);
                return (
                  <div key={form} className="border-b border-rule last:border-0">
                    <button
                      className="flex w-full items-center gap-1.5 bg-paper px-3 py-1 text-left text-xs font-semibold text-graphite hover:text-ink"
                      onClick={() =>
                        setClosed((s) => {
                          const n = new Set(s);
                          n.has(form) ? n.delete(form) : n.add(form);
                          return n;
                        })
                      }
                      aria-expanded={!isClosed}
                    >
                      {isClosed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
                      {form}
                      <span className="font-normal text-faint">{rs.length} line(s)</span>
                      {rs.some((r) => r.causes.includes('ours')) && (
                        <Pill tone="adj">
                          <PenLine size={10} /> adjusted
                        </Pill>
                      )}
                    </button>
                    {!isClosed &&
                      rs.map((r) => {
                        const target = r.d.change === 'removed' ? lineId(a, r.d.key) : lineId(b, r.d.key);
                        const delta = typeof r.d.a === 'number' && typeof r.d.b === 'number' ? r.d.b - r.d.a : undefined;
                        const ours = r.causes.includes('ours');
                        return (
                          <div
                            key={r.d.key}
                            className={clsx('grid cursor-pointer grid-cols-[110px_minmax(0,1fr)_110px_20px_150px_100px_minmax(150px,240px)] items-center gap-2 border-t border-ruleSoft px-3 py-1 text-sm hover:bg-paper', ours && 'bg-blue-soft/30')}
                            onClick={() => drawer.open(target)}
                          >
                            <span className="truncate text-xs text-graphite">{r.d.key}</span>
                            <span className="min-w-0 truncate" title={r.d.label}>
                              {r.d.label}
                              {r.d.change !== 'changed' && (
                                <span className="ml-1.5">
                                  <Pill tone={r.d.change === 'added' ? 'ok' : 'bad'}>{r.d.change}</Pill>
                                </span>
                              )}
                            </span>
                            <span className="text-right text-graphite">{r.d.change === 'added' ? <span className="text-faint">—</span> : <Num cell={{ value: r.d.a, nodeId: lineId(a, r.d.key) }} kind={kindOf(r.d.a)} />}</span>
                            <ArrowRight size={12} className="text-faint" />
                            <span className="text-right">
                              {r.d.change === 'removed' ? (
                                <span className="text-faint">—</span>
                              ) : ours ? (
                                <Num cell={{ value: r.d.b, engineValue: r.engineB, nodeId: target, adjusted: true }} kind={kindOf(r.d.b)} />
                              ) : (
                                <Num cell={{ value: r.d.b, nodeId: target }} kind={kindOf(r.d.b)} />
                              )}
                            </span>
                            <span className={clsx('text-right', delta !== undefined && Math.abs(delta) >= 1000 && 'font-semibold')}>{delta !== undefined && Number.isInteger(delta) ? <Signed value={delta} /> : delta !== undefined ? <span className="num text-xs">{delta > 0 ? '+' : ''}{delta.toFixed(4)}</span> : null}</span>
                            <span className="flex min-w-0 flex-wrap items-center gap-1 text-2xs">
                              {r.causes.includes('engine') && (
                                <Pill tone="info" title={r.steps.map((v) => `${v}: ${triggers.get(v) ?? ''}`).join('\n') || 'Engine output differs between the runs'}>
                                  <Cpu size={10} /> engine {r.steps.join(', ') || 'recompute'}
                                </Pill>
                              )}
                              {ours && (
                                <Pill tone="adj" title={r.reason ?? 'Approved workpaper adjustment'}>
                                  <PenLine size={10} /> our adjustment
                                </Pill>
                              )}
                              {ours && r.reason && <span className="truncate text-graphite" title={r.reason}>{r.reason}</span>}
                            </span>
                          </div>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          </>
        )
      )}
    </div>
  );
}
