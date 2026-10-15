// Return summary vs 2024: the firm variance rule applied line by line. Lines over the
// threshold without an explanation lead; each can be explained in place.
import type { ViewDto, ViewRow } from '@easetax/shared';
import clsx from 'clsx';
import { useMemo, useState } from 'react';
import { api } from '../../api/client';
import { fmtNum } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { useSession } from '../../state/session';
import { useCommand } from '../actions';
import { ErrorBox } from '../ui';
import { Box, Num, Pill, Rest, Signed, Stat, num, sectionsOf } from './kit';

interface Rule {
  compare_to: string;
  flag_if_change_over_percent: number;
  and_over_amount: number;
}

const statusRank = (s?: string) => (s === 'needs explanation' ? 0 : s === 'explained' ? 1 : 2);

export function SummaryVsPrior({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const meta = (view.meta ?? {}) as { rule?: Rule; flagged?: number; explained?: number };
  const key = s.get('key');
  const all = s.get('all');
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [q, setQ] = useState('');
  const allRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return [...(all?.rows ?? [])]
      .filter((r) => (!onlyOpen || r.status === 'needs explanation') && (!needle || `${r.label} ${r.sublabel}`.toLowerCase().includes(needle)))
      .sort((a, b) => statusRank(a.status) - statusRank(b.status) || Math.abs(num(b.cells.delta) ?? 0) - Math.abs(num(a.cells.delta) ?? 0));
  }, [all, onlyOpen, q]);
  const rule = meta.rule;
  const flagged = meta.flagged ?? 0;
  const explained = meta.explained ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Firm variance rule">{rule ? <span className="text-sm">over {rule.flag_if_change_over_percent}% and over {fmtNum(rule.and_over_amount)}</span> : '—'}</Stat>
        <Stat label="Over threshold">{flagged}</Stat>
        <Stat label="Explained" tone={explained === flagged ? 'ok' : undefined}>
          {explained}
        </Stat>
        <Stat label="Need an explanation" tone={flagged - explained > 0 ? 'warn' : 'ok'}>
          {flagged - explained}
        </Stat>
      </div>
      {key && (
        <Box title={key.title} note="The return’s headline lines, 2024 → 2025. Bars show the size of the change; amber means over the firm threshold.">
          <VarianceList rows={key.rows} />
        </Box>
      )}
      {all && (
        <Box
          title={all.title}
          note={all.note}
          right={
            <span className="flex items-center gap-3">
              <input className="input w-[200px]" placeholder="Filter lines" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter lines" />
              <label className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Needs explanation only
              </label>
            </span>
          }
        >
          {allRows.length ? <VarianceList rows={allRows} /> : <div className="px-3 py-4 text-sm text-faint">{onlyOpen ? 'Every line over the threshold is explained.' : 'No lines match.'}</div>}
        </Box>
      )}
      <Rest sections={s.rest(['key', 'all'])} />
    </div>
  );
}

function VarianceList({ rows }: { rows: ViewRow[] }) {
  const drawer = useDrawer();
  const [explaining, setExplaining] = useState<string | null>(null);
  return (
    <div role="table" className="text-sm">
      <div role="row" className="grid grid-cols-[minmax(0,1fr)_110px_120px_100px_70px_150px_minmax(120px,220px)] gap-2 border-b border-rule px-3 py-1.5 text-xs font-semibold text-graphite">
        <span>Line</span>
        <span className="text-right">2024</span>
        <span className="text-right">2025 (effective)</span>
        <span className="text-right">Δ</span>
        <span className="text-right">Δ%</span>
        <span className="text-center">change</span>
        <span>Explanation</span>
      </div>
      {rows.map((r) => {
        const delta = num(r.cells.delta);
        const pct = num(r.cells.deltaPct);
        const need = r.status === 'needs explanation';
        const flaggedRow = need || r.status === 'explained';
        const expl = r.cells.explanation?.value as string | null | undefined;
        return (
          <div key={r.id} role="row" className={clsx('border-b border-ruleSoft', need && 'bg-amber-soft/30')}>
            <div className="grid cursor-pointer grid-cols-[minmax(0,1fr)_110px_120px_100px_70px_150px_minmax(120px,220px)] items-center gap-2 px-3 py-1.5 hover:bg-paper" onClick={() => r.nodeId && drawer.open(r.nodeId)}>
              <span className="min-w-0 truncate" title={r.label}>
                {r.label} <span className="text-xs text-faint">{r.sublabel}</span>
              </span>
              <span className="text-right text-graphite">
                <Num cell={r.cells.prior} />
              </span>
              <span className="text-right">
                <Num cell={r.cells.current} />
              </span>
              <span className={clsx('text-right', need ? 'font-semibold text-amber-ink' : 'text-graphite')}>
                <Signed value={delta} />
              </span>
              <span className="num text-right text-xs text-graphite">{pct === undefined ? '' : `${Math.abs(pct) >= 1000 ? (pct > 0 ? '>999' : '<−999') : pct.toFixed(0)}%`}</span>
              <DeltaBar pct={pct} flagged={flaggedRow} />
              <span className="min-w-0 text-xs" onClick={(e) => e.stopPropagation()}>
                {expl ? (
                  <span className="text-ledger-ink" title={r.cells.explanation?.note}>
                    ✓ {expl}
                  </span>
                ) : need ? (
                  <button className="btn-ghost text-xs text-amber-ink" onClick={() => setExplaining(explaining === r.id ? null : r.id)}>
                    Explain…
                  </button>
                ) : (
                  <Pill tone="info">within threshold</Pill>
                )}
              </span>
            </div>
            {explaining === r.id && r.nodeId && <ExplainForm nodeId={r.nodeId} onDone={() => setExplaining(null)} />}
          </div>
        );
      })}
    </div>
  );
}

/** Diverging bar, log-scaled so +6,000% and +12% are both legible. */
function DeltaBar({ pct, flagged }: { pct: number | undefined; flagged: boolean }) {
  if (pct === undefined) return <span />;
  const mag = Math.min(1, Math.log10(1 + Math.abs(pct)) / 3); // 0..1 over 0%..999%
  const w = `${(mag * 50).toFixed(1)}%`;
  return (
    <span className="relative h-2.5 w-full rounded-sm bg-ruleSoft" aria-hidden>
      <span className="absolute inset-y-0 left-1/2 w-px bg-rule" />
      <span className={clsx('absolute inset-y-0 rounded-sm', flagged ? 'bg-amber' : 'bg-faint/60')} style={pct >= 0 ? { left: '50%', width: w } : { right: '50%', width: w }} />
    </span>
  );
}

function ExplainForm({ nodeId, onDone }: { nodeId: string; onDone: () => void }) {
  const { can } = useSession();
  const run = useCommand();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  if (!can('verify')) return <div className="px-3 pb-2 text-xs text-faint">Your role cannot record variance explanations.</div>;
  return (
    <form
      className="flex items-start gap-2 px-3 pb-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        setErr(null);
        try {
          await run(() => api('/api/variances/explain', { method: 'POST', body: { nodeId, explanation: text.trim() } }), { done: 'Variance explained' });
          onDone();
        } catch (x) {
          setErr(x);
        } finally {
          setBusy(false);
        }
      }}
    >
      <input className="input flex-1" autoFocus placeholder="Why did this line change? e.g. new employer from June; RSU vesting" value={text} onChange={(e) => setText(e.target.value)} aria-label="Variance explanation" />
      <button className="btn-primary" disabled={busy || !text.trim()}>
        Record
      </button>
      <button type="button" className="btn-ghost" onClick={onDone}>
        Cancel
      </button>
      {!!err && <ErrorBox error={err} />}
    </form>
  );
}
