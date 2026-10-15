// Return map: the return summary across engine versions, then the return as review areas.
import type { AreaDto, ReturnSummaryDto, SignoffDto } from '@easetax/shared';
import { lineId } from '@easetax/shared';
import clsx from 'clsx';
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAreas, useSummary } from '../api/hooks';
import { Loading, TraceValue } from '../components/ui';
import { fmtNum, fmtSigned, humanize } from '../lib/format';
import { useListNav } from '../lib/useListNav';

export function ReturnMap() {
  const summary = useSummary();
  const areas = useAreas();
  const navigate = useNavigate();
  const grid = useRef<HTMLDivElement>(null);
  const list = areas.data ?? [];
  const [cursor, setCursor] = useListNav(list.length, { Enter: () => list[cursor] && navigate(`/areas/${list[cursor]!.id}`) });
  useEffect(() => {
    (grid.current?.querySelector(`[data-idx="${cursor}"]`) as HTMLElement | null)?.focus();
  }, [cursor]);

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-5">
      <h1 className="mb-1 font-serif text-2xl font-semibold">Return map</h1>
      <p className="mb-4 text-sm text-graphite">Totals from each engine run, and every review area with its proof status. Every number opens its trace.</p>
      {summary.data ? <SummaryTable s={summary.data} /> : <Loading what="summary" />}
      <h2 className="mb-2 mt-6 text-sm font-semibold text-graphite">Review areas</h2>
      {!areas.data ? (
        <Loading what="areas" />
      ) : (
        <div ref={grid} className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.map((a, i) => (
            <AreaCard key={a.id} a={a} idx={i} active={i === cursor} onClick={() => (setCursor(i), navigate(`/areas/${a.id}`))} />
          ))}
        </div>
      )}
    </div>
  );
}

type Fed = ReturnSummaryDto['versions'][number]['federal'];
type Ca = ReturnSummaryDto['versions'][number]['california'];

// Each total is a return line in every engine version, and (where it existed) a line on the 2024 return.
const ROWS: { label: string; fed?: keyof Fed; ca?: keyof Ca; fedKey?: string; caKey?: string; fedPrior?: string; caPrior?: string; effect?: 'tax' | 'balance' }[] = [
  { label: 'Adjusted gross income', fed: 'agi', ca: 'total_agi', fedKey: 'F1040.11', caKey: 'F540NR.17', fedPrior: 'F1040.11', caPrior: 'CA540.17' },
  { label: 'California AGI', ca: 'ca_agi', caKey: 'F540NR.32', caPrior: 'CA540.17' },
  { label: 'Taxable income', fed: 'taxable_income', fedKey: 'F1040.15', fedPrior: 'F1040.15' },
  { label: 'Total tax', fed: 'total_tax', ca: 'total_tax', fedKey: 'F1040.24', caKey: 'F540NR.64', fedPrior: 'F1040.24', caPrior: 'CA540.64', effect: 'tax' },
  { label: 'Payments', fed: 'payments', ca: 'payments', fedKey: 'F1040.33', caKey: 'F540NR.78', fedPrior: 'F1040.33' },
  { label: 'Balance due (refund)', fed: 'balance_due', ca: 'balance_due', fedKey: 'F1040.37', caKey: 'F540NR.97', effect: 'balance' },
  { label: 'Penalty', fed: 'penalty', ca: 'penalty', fedKey: 'F1040.38', caKey: 'FTB5805.penalty' },
];

const priorNode = (key: string) => `py:/return_2024/lines/${key}`;

function SummaryTable({ s }: { s: ReturnSummaryDto }) {
  const cur = s.currentVersion;
  const ae = s.adjustmentEffect;
  const hasAdj = ae.federalTax || ae.californiaTax || ae.federalBalance || ae.californiaBalance;
  const cell = 'num px-3 py-1.5 text-right';
  const est = (n: number) => (n ? <span className="text-blue-ink">≈ {fmtSigned(n)}</span> : <span className="text-faint">—</span>);
  return (
    <div className="overflow-x-auto rounded border border-rule bg-panel">
      <table className="w-full min-w-[820px] text-sm">
        <thead>
          <tr className="border-b border-rule text-xs text-graphite">
            <th className="px-3 py-2 text-left font-semibold">Federal</th>
            {s.versions.map((v) => (
              <th key={v.version} className={clsx('px-3 py-2 text-right font-semibold', v.version === cur && 'bg-paper text-ink')} title={v.trigger}>
                Engine {v.version}
                <span className="block text-2xs font-normal text-faint">{v.computedAt.slice(0, 10)}</span>
              </th>
            ))}
            <th className="px-3 py-2 text-right font-semibold text-blue-ink">
              Workpaper adjustments
              <span className="block text-2xs font-normal">estimated, on {cur}</span>
            </th>
            <th className="px-3 py-2 text-right font-semibold">
              Prior year<span className="block text-2xs font-normal text-faint">2024 return</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ROWS.filter((r) => r.fed).map((r) => (
            <tr key={'f' + r.label} className="border-b border-ruleSoft">
              <td className="px-3 py-1.5">{r.label}</td>
              {s.versions.map((v) => (
                <td key={v.version} className={clsx(cell, v.version === cur && 'bg-paper font-semibold')}>
                  {r.fedKey ? <TraceValue nodeId={lineId(v.version, r.fedKey)} value={v.federal[r.fed!]} /> : fmtNum(v.federal[r.fed!])}
                </td>
              ))}
              <td className={cell}>{r.effect === 'tax' ? est(ae.federalTax) : r.effect === 'balance' ? est(ae.federalTax + ae.federalBalance) : ''}</td>
              <td className={clsx(cell, 'text-graphite')}>
                <Prior s={s} k={r.fedPrior} />
              </td>
            </tr>
          ))}
          <tr className="border-b border-rule text-xs text-graphite">
            <th className="px-3 pb-1.5 pt-3 text-left font-semibold" colSpan={s.versions.length + 3}>
              California 540NR (part-year; moved to Texas 2025-07-15)
            </th>
          </tr>
          {ROWS.filter((r) => r.ca).map((r) => (
            <tr key={'c' + r.label} className="border-b border-ruleSoft last:border-0">
              <td className="px-3 py-1.5">{r.label}</td>
              {s.versions.map((v) => (
                <td key={v.version} className={clsx(cell, v.version === cur && 'bg-paper font-semibold')}>
                  {r.caKey ? <TraceValue nodeId={lineId(v.version, r.caKey)} value={v.california[r.ca!]} /> : fmtNum(v.california[r.ca!])}
                </td>
              ))}
              <td className={cell}>{r.effect === 'tax' ? est(ae.californiaTax) : r.effect === 'balance' ? est(ae.californiaTax + ae.californiaBalance) : ''}</td>
              <td className={clsx(cell, 'text-graphite')}>
                <Prior s={s} k={r.caPrior} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-rule px-3 py-1.5 text-xs text-graphite">
        {hasAdj
          ? 'Adjustment effects are estimates (change × the engine’s tax-effect rates); the engine has not been rerun, so totals by version are as computed.'
          : 'No workpaper adjustments are in force yet. When they are, their estimated effect appears here with ≈.'}{' '}
        {s.status.pendingAdjustments > 0 && <span className="font-semibold text-amber-ink">{s.status.pendingAdjustments} adjustment(s) wait for a partner and are not counted.</span>}
      </div>
    </div>
  );
}

/** A 2024 figure, traceable to the value read from the 2024 return as filed (D06). */
function Prior({ s, k }: { s: ReturnSummaryDto; k?: string }) {
  const v = k ? s.priorYear.lines?.[k] : undefined;
  return k && typeof v === 'number' ? <TraceValue nodeId={priorNode(k)} value={v} /> : null;
}

export function signoffState(signoffs: SignoffDto[]) {
  const reopened = signoffs.filter((s) => s.status === 'reopened');
  const valid = signoffs.filter((s) => s.status === 'valid');
  return { reopened, valid };
}

function AreaCard({ a, idx, active, onClick }: { a: AreaDto; idx: number; active: boolean; onClick: () => void }) {
  const pct = a.lineCount ? Math.round((a.verifiedLines / a.lineCount) * 100) : 0;
  const { reopened, valid } = signoffState(a.signoffs);
  const over = a.budgetHours !== undefined && a.loggedHours > a.budgetHours;
  return (
    <button
      data-idx={idx}
      onClick={onClick}
      className={clsx('flex flex-col rounded border bg-panel p-3 text-left hover:border-graphite focus:outline-none', active ? 'border-blue ring-1 ring-blue' : 'border-rule')}
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-semibold">{a.title}</div>
          <div className="text-xs text-faint">{a.forms.join(', ')}</div>
        </div>
        <Ring pct={pct} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <Stat label="Lines verified" value={`${a.verifiedLines} / ${a.lineCount}`} />
        <Stat label="Open issues" value={String(a.openIssues)} tone={a.openIssues ? 'bad' : 'good'} />
        <Stat label="Hours" value={`${a.loggedHours}${a.budgetHours !== undefined ? ` / ${a.budgetHours}` : ''}`} tone={over ? 'bad' : undefined} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1 text-2xs">
        {a.signoffs.length === 0 && <span className="text-faint">Not signed off</span>}
        {valid.map((s) => (
          <span key={s.id} className="rounded bg-ledger-soft px-1.5 font-semibold text-ledger-ink">
            {humanize(s.level)} signed
          </span>
        ))}
        {reopened.map((s) => (
          <span key={s.id} className="rounded bg-pencil px-1.5 font-semibold text-white">
            {humanize(s.level)} reopened
          </span>
        ))}
        {a.adjustedLines > 0 && <span className="rounded bg-blue-soft px-1.5 text-blue-ink">{a.adjustedLines} adjusted</span>}
        {a.considered && <span className="rounded bg-ruleSoft px-1.5 text-graphite">considered</span>}
      </div>
    </button>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div>
      <div className="text-2xs text-faint">{label}</div>
      <div className={clsx('num font-semibold', tone === 'bad' && 'text-pencil', tone === 'good' && 'text-ledger')}>{value}</div>
    </div>
  );
}

/** Verified share as a ring: the area's "proof" at a glance. */
function Ring({ pct }: { pct: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" role="img" aria-label={`${pct}% of lines verified`}>
      <circle cx="20" cy="20" r={r} fill="none" stroke="#ECEFEA" strokeWidth="4" />
      <circle cx="20" cy="20" r={r} fill="none" stroke="#2E6A4E" strokeWidth="4" strokeDasharray={`${(pct / 100) * c} ${c}`} transform="rotate(-90 20 20)" strokeLinecap="butt" />
      <text x="20" y="23.5" textAnchor="middle" fontSize="10" fontWeight="600" fill="#1A2420">
        {pct}%
      </text>
    </svg>
  );
}
