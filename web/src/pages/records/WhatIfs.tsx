// What-ifs: the engine's precomputed alternatives (exact) side by side with the base, and a
// scenario builder that estimates hypothetical line values from the engine's tax-effect
// rates. Scenarios are never saved and never touch the return.
import type { NodeSummary } from '@easetax/shared';
import { lineId } from '@easetax/shared';
import clsx from 'clsx';
import { Calculator, Cpu, FlaskConical, Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearch } from '../../api/hooks';
import { useScenario, useWhatIfs, type CaTotals, type FedTotals, type ScenarioResult, type WhatIfAlternative } from '../../api/recordsHooks';
import { Collapsible, NodeChip, Pill, Plain, Signed } from '../../components/records/kit';
import { ErrorBox, Loading, TraceValue } from '../../components/ui';
import { fmtNum, fmtSigned, fmtValue, humanize } from '../../lib/format';

export function WhatIfs() {
  const w = useWhatIfs();
  return (
    <div className="mx-auto max-w-[1280px] px-6 py-5">
      <h1 className="mb-1 font-serif text-2xl font-semibold">What-ifs</h1>
      <p className="mb-4 max-w-[820px] text-sm text-graphite">
        Alternatives the engine computed in full (exact figures), and your own scenarios estimated from the engine’s tax-effect rates (always marked ≈). Neither changes the return; to change the
        return, adjust a line from its trace.
      </p>
      <ErrorBox error={w.error} />
      {w.isLoading && <Loading what="alternatives" />}
      {w.data && (
        <section className="mb-6">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-graphite">
            <Cpu size={14} /> Engine alternatives <span className="font-normal text-faint">computed by the engine on {w.data.alternatives[0]?.base_version ?? 'the current version'}; exact</span>
          </h2>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {[...w.data.alternatives].map((alt) => (
              <AlternativeCard key={alt.id} alt={alt} />
            ))}
          </div>
          {w.data.extension && (
            <p className="mt-3 text-xs text-graphite">
              Extension estimate (computed {w.data.extension.computed_at.slice(0, 10)} on {w.data.extension.based_on_version}): federal balance {fmtValue(w.data.extension.federal.estimated_balance)}, paid with
              Form 4868 {fmtValue(w.data.extension.federal.paid_with_form_4868)}; California balance {fmtValue(w.data.extension.california.estimated_balance)}.
            </p>
          )}
        </section>
      )}
      <ScenarioBuilder />
    </div>
  );
}

const FED_ROWS: [keyof FedTotals, string, string?][] = [
  ['agi', 'AGI', 'F1040.11'],
  ['taxable_income', 'Taxable income', 'F1040.15'],
  ['total_tax', 'Total tax', 'F1040.24'],
  ['payments', 'Payments', 'F1040.33'],
  ['balance_due', 'Balance due (refund)', 'F1040.37'],
  ['penalty', 'Penalty', 'F1040.38'],
];
const CA_ROWS: [keyof CaTotals, string, string?][] = [
  ['total_agi', 'Total AGI (CA law)', 'F540NR.17'],
  ['ca_agi', 'California AGI', 'F540NR.32'],
  ['total_tax', 'Total tax', 'F540NR.64'],
  ['payments', 'Payments', 'F540NR.78'],
  ['balance_due', 'Balance due (refund)'],
  ['penalty', 'Penalty'],
];

function AlternativeCard({ alt }: { alt: WhatIfAlternative }) {
  const fed = alt.federal.total_tax_change;
  const ca = alt.california.total_tax_change;
  const both = fed + ca;
  const none = alt.changed_lines.length === 0 && !fed && !ca;
  return (
    <article className={clsx('rounded border bg-panel', both < 0 ? 'border-ledger/60' : both > 0 ? 'border-rule' : 'border-rule')}>
      <header className="border-b border-rule px-3 py-2">
        <div className="flex items-start gap-2">
          <h3 className="min-w-0 flex-1 text-sm font-semibold">{alt.description}</h3>
          <Pill tone="info">{alt.id}</Pill>
        </div>
        <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
          <Change label="Federal tax" v={fed} />
          <Change label="California tax" v={ca} />
          <Change label="Combined" v={both} strong />
          {alt.federal.penalty_change ? <Change label="Fed penalty" v={alt.federal.penalty_change} /> : null}
          {none && <span className="text-xs text-faint">No effect on this return.</span>}
        </div>
      </header>
      {!none && (
        <div className="grid grid-cols-1 gap-0 md:grid-cols-2">
          <Totals title="Federal" rows={FED_ROWS} base={alt.federal.base} alt={alt.federal.alternative} version={alt.base_version} />
          <Totals title="California" rows={CA_ROWS} base={alt.california.base} alt={alt.california.alternative} version={alt.base_version} className="md:border-l md:border-rule" />
        </div>
      )}
      {alt.changed_lines.length > 0 && (
        <div className="border-t border-rule">
          <Collapsible title={<span>{alt.changed_lines.length} line(s) the engine changed</span>}>
            <ul className="max-h-[260px] overflow-auto px-3 pb-2 text-xs">
              {alt.changed_lines.map((c) => (
                <li key={c.key} className="flex items-center gap-2 border-b border-ruleSoft py-0.5 last:border-0">
                  <NodeChip id={lineId(alt.base_version, c.key)} label={c.key} />
                  <span className="flex-1" />
                  <span className="num text-faint">{fmtValue(c.old)}</span>
                  <span className="text-faint">→</span>
                  <span className="num font-semibold">{fmtValue(c.new)}</span>
                  <span className="w-[70px] text-right">{typeof c.old === 'number' && typeof c.new === 'number' && Number.isInteger(c.new - c.old) ? <Signed value={c.new - c.old} /> : null}</span>
                </li>
              ))}
            </ul>
          </Collapsible>
        </div>
      )}
    </article>
  );
}

function Change({ label, v, strong }: { label: string; v: number; strong?: boolean }) {
  return (
    <span className="whitespace-nowrap">
      <span className="text-xs text-graphite">{label} </span>
      <span className={clsx('num', strong && 'font-semibold', v < 0 ? 'text-ledger-ink' : v > 0 ? 'text-pencil-ink' : 'text-faint')}>{v === 0 ? 'no change' : fmtSigned(v)}</span>
    </span>
  );
}

function Totals<T extends FedTotals | CaTotals>({ title, rows, base, alt, version, className }: { title: string; rows: [keyof T, string, string?][]; base: T; alt: T; version: string; className?: string }) {
  return (
    <table className={clsx('w-full text-xs', className)}>
      <thead>
        <tr className="text-graphite">
          <th className="px-3 py-1 text-left font-semibold">{title}</th>
          <th className="px-2 py-1 text-right font-semibold">Base</th>
          <th className="px-2 py-1 text-right font-semibold">Alternative</th>
          <th className="px-2 py-1 text-right font-semibold">Δ</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([k, label, key]) => {
          const b = base[k] as unknown as number;
          const a = alt[k] as unknown as number;
          const d = a - b;
          return (
            <tr key={String(k)} className={clsx('border-t border-ruleSoft', d !== 0 && 'bg-amber-soft/40')}>
              <td className="px-3 py-0.5">{label}</td>
              <td className="px-2 py-0.5 text-right">{key ? <TraceValue nodeId={lineId(version, key)} value={b} /> : <Plain value={b} />}</td>
              <td className={clsx('px-2 py-0.5 text-right', d !== 0 && 'font-semibold')}>
                <Plain value={a} />
              </td>
              <td className="px-2 py-0.5 text-right">{d ? <Signed value={d} /> : <span className="text-faint">—</span>}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// ------------------------------------------------------------------ scenario builder

interface Pick {
  nodeId: string;
  label: string;
  sublabel?: string;
  current: unknown;
  input: string;
}

const STORE = 'easetax.scenario';
function loadPicks(): Pick[] {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) ?? '[]') as Pick[];
  } catch {
    return [];
  }
}

function parseAmount(s: string): number | null {
  const t = s.replace(/[,\s$]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!t || !/^-?\d*\.?\d+$/.test(t)) return null;
  return Number(t);
}

function ScenarioBuilder() {
  const [picks, setPicks] = useState<Pick[]>(loadPicks);
  const [q, setQ] = useState('');
  const search = useSearch(q);
  const scenario = useScenario();
  const [result, setResult] = useState<ScenarioResult | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(picks));
    } catch {
      /* storage unavailable */
    }
  }, [picks]);

  const changes = useMemo(
    () => picks.map((p) => ({ nodeId: p.nodeId, newValue: parseAmount(p.input) })).filter((c): c is { nodeId: string; newValue: number } => c.newValue !== null),
    [picks],
  );
  const changesKey = JSON.stringify(changes);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!changes.length) {
      setResult(null);
      return;
    }
    timer.current = setTimeout(() => {
      scenario.mutate(changes, { onSuccess: setResult });
    }, 350);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [changesKey]);

  const lineHits = (search.data ?? []).filter((n) => n.kind === 'line' && !picks.some((p) => p.nodeId === n.id)).slice(0, 12);
  const add = (n: NodeSummary) => {
    const cur = n.effectiveValue ?? n.value;
    setPicks((ps) => [...ps, { nodeId: n.id, label: n.label, sublabel: n.sublabel, current: cur, input: typeof cur === 'number' ? String(cur) : '' }]);
    setQ('');
  };
  const rowFor = (id: string) => result?.rows.find((r) => r.nodeId === id);
  const t = result?.total;
  const fedBase = result?.base.federal;
  const caBase = result?.base.california;

  return (
    <section aria-label="Scenario builder" className="rounded border border-blue/40 bg-panel">
      <header className="flex flex-wrap items-center gap-2 border-b border-rule bg-blue-soft/40 px-3 py-2">
        <FlaskConical size={15} className="text-blue-ink" />
        <h2 className="text-sm font-semibold">Scenario builder</h2>
        <Pill tone="adj">≈ estimated</Pill>
        <span className="text-xs text-graphite">Hypothetical values only. Nothing is saved to the workpaper and the return does not change.</span>
      </header>
      <div className="p-3">
        <div className="relative max-w-[520px]">
          <input className="input" placeholder="Add a line: search e.g. SchC.1, mortgage interest, SEP" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search lines to add" />
          {q.trim().length >= 2 && (
            <ul className="absolute left-0 right-0 top-full z-20 mt-1 max-h-[320px] overflow-auto rounded border border-rule bg-panel py-1 shadow-xl" role="listbox">
              {search.isLoading && <li className="px-3 py-1.5 text-xs text-faint">Searching…</li>}
              {!search.isLoading && lineHits.length === 0 && <li className="px-3 py-1.5 text-xs text-faint">No return lines match.</li>}
              {lineHits.map((n) => (
                <li key={n.id}>
                  <button className="flex w-full items-center gap-2 px-3 py-1 text-left text-sm hover:bg-blue-soft" onClick={() => add(n)} role="option" aria-selected={false}>
                    <Plus size={12} className="text-faint" />
                    <span className="w-[110px] shrink-0 truncate text-xs text-graphite">{n.sublabel}</span>
                    <span className="min-w-0 flex-1 truncate">{n.label}</span>
                    <span className="num text-xs text-graphite">{fmtValue(n.effectiveValue ?? n.value)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {picks.length === 0 ? (
          <div className="mt-4 rounded border border-dashed border-rule px-4 py-6 text-center text-sm text-faint">
            <Calculator size={18} className="mx-auto mb-1" />
            Add one or more lines and type the value you want to try. The estimate updates as you type.
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead>
                <tr className="border-b border-rule text-xs text-graphite">
                  <th className="px-2 py-1.5 text-left font-semibold">Line</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Current (effective)</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Try</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Δ</th>
                  <th className="px-2 py-1.5 text-right font-semibold">≈ Fed tax</th>
                  <th className="px-2 py-1.5 text-right font-semibold">≈ CA tax</th>
                  <th className="px-2 py-1.5 text-left font-semibold">How estimated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {picks.map((p, i) => {
                  const r = rowFor(p.nodeId);
                  const nv = parseAmount(p.input);
                  const delta = nv !== null && typeof p.current === 'number' ? nv - p.current : undefined;
                  const est = r?.effect;
                  return (
                    <tr key={p.nodeId} className="border-b border-ruleSoft align-top">
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-1.5">
                          <NodeChip id={p.nodeId} label={p.sublabel ?? p.nodeId} />
                          <span className="truncate">{p.label}</span>
                        </div>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <TraceValue nodeId={p.nodeId} value={p.current} />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <input
                          className={clsx('input num w-[120px] text-right', p.input && nv === null && 'border-pencil')}
                          value={p.input}
                          inputMode="decimal"
                          onChange={(e) => setPicks((ps) => ps.map((x, j) => (j === i ? { ...x, input: e.target.value } : x)))}
                          aria-label={`Hypothetical value for ${p.label}`}
                        />
                      </td>
                      <td className="px-2 py-1.5 text-right">{delta !== undefined ? <Signed value={delta} /> : null}</td>
                      <td className="px-2 py-1.5 text-right">{est ? est.estimable ? <Approx v={est.federalTax} /> : <span className="text-xs text-faint">not estimable</span> : null}</td>
                      <td className="px-2 py-1.5 text-right">{est?.estimable ? <Approx v={est.californiaTax} /> : null}</td>
                      <td className="max-w-[260px] px-2 py-1.5 text-xs text-graphite">
                        {est?.basis}
                        {(est?.federalBalance || est?.californiaBalance) && (
                          <div>
                            balance ≈ {fmtSigned(est.federalBalance)} fed, ≈ {fmtSigned(est.californiaBalance)} CA
                          </div>
                        )}
                        {est?.warnings.map((w, k) => (
                          <div key={k} className="text-amber-ink">
                            {w}
                          </div>
                        ))}
                      </td>
                      <td className="px-1 py-1.5">
                        <button className="btn-ghost" onClick={() => setPicks((ps) => ps.filter((_, j) => j !== i))} aria-label={`Remove ${p.label}`}>
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <ErrorBox error={scenario.error} />
            {t && fedBase && caBase && (
              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                <ScenarioTotal title="Federal" taxBase={fedBase.total_tax} tax={t.federalTax} balBase={fedBase.balance_due} bal={t.federalTax + t.federalBalance} />
                <ScenarioTotal title="California" taxBase={caBase.total_tax} tax={t.californiaTax} balBase={caBase.balance_due} bal={t.californiaTax + t.californiaBalance} />
              </div>
            )}
            <div className="mt-2 flex items-center gap-3 text-xs text-faint">
              {scenario.isPending && <span>Estimating…</span>}
              <span>Estimates multiply each change by the engine’s rate for that line’s category; they do not rerun the engine and can miss brackets and phase-outs.</span>
              <span className="flex-1" />
              <button className="btn-ghost text-xs" onClick={() => setPicks([])}>
                Clear scenario
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function Approx({ v }: { v: number }) {
  const r = Math.round(v);
  return <span className={clsx('num', r < 0 ? 'text-ledger-ink' : r > 0 ? 'text-pencil-ink' : 'text-faint')}>≈ {r === 0 ? '0' : fmtSigned(r)}</span>;
}

function ScenarioTotal({ title, taxBase, tax, balBase, bal }: { title: string; taxBase: number; tax: number; balBase: number; bal: number }) {
  return (
    <div className="rounded border border-blue/40 bg-blue-soft/30 px-3 py-2">
      <div className="flex items-center gap-2 text-xs font-semibold text-graphite">
        {title} <Pill tone="adj">≈ estimated</Pill>
      </div>
      <div className="mt-1 grid grid-cols-[auto_1fr_1fr] gap-x-4 gap-y-0.5 text-sm">
        <span />
        <span className="text-right text-2xs text-graphite">change</span>
        <span className="text-right text-2xs text-graphite">≈ result</span>
        <span className="text-graphite">Total tax</span>
        <span className="text-right">
          <Approx v={tax} />
        </span>
        <span className="num text-right font-semibold">≈ {fmtNum(Math.round(taxBase + tax))}</span>
        <span className="text-graphite">{humanize('balance due (refund)')}</span>
        <span className="text-right">
          <Approx v={bal} />
        </span>
        <span className="num text-right font-semibold">≈ {fmtNum(Math.round(balBase + bal))}</span>
      </div>
    </div>
  );
}
