// Deductions and credits with the limits applied, and retirement and foreign.
import type { ViewDto, ViewRow } from '@easetax/shared';
import clsx from 'clsx';
import { useDrawer } from '../../state/drawer';
import { LineList } from './Rentals';
import { Box, FlagText, Num, Pill, Plain, Rest, Verdict, num, rowTone, sectionsOf } from './kit';

export function DeductionsCredits({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const limits = s.get('limits');
  const a = s.get('schedule-a');
  const credits = s.get('credits');
  const dd = s.get('due-diligence');
  return (
    <div className="space-y-4">
      {limits && (
        <Box title={limits.title} note="Each bar is the amount claimed against its limit; red is the part the limit cuts off.">
          <div className="divide-y divide-ruleSoft">
            {limits.rows.map((r) => (
              <LimitBar key={r.id} r={r} />
            ))}
          </div>
        </Box>
      )}
      {dd && (
        <Box title={dd.title}>
          {dd.rows.map((r) => (
            <div key={r.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span>{r.label}</span>
              <span className="flex items-center gap-2">
                <Pill tone={/not/i.test(String(r.cells.amount?.value ?? r.status)) ? 'bad' : 'ok'}>{String(r.cells.amount?.value ?? r.status)}</Pill>
                <Num cell={r.cells.amount} kind="text" className="text-xs" />
              </span>
            </div>
          ))}
        </Box>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {a && (
          <Box title={a.title}>
            <LineList rows={a.rows} findings={view.findings} />
          </Box>
        )}
        {credits && (
          <Box title={credits.title}>
            <LineList rows={credits.rows} findings={view.findings} />
          </Box>
        )}
      </div>
      <Rest sections={s.rest(['limits', 'schedule-a', 'credits', 'due-diligence'])} />
    </div>
  );
}

function LimitBar({ r }: { r: ViewRow }) {
  const drawer = useDrawer();
  const amount = num(r.cells.amount) ?? 0;
  const limit = num(r.cells.limit) ?? 0;
  const over = num(r.cells.over);
  const isChoice = r.cells.over === undefined; // e.g. itemized vs standard: a comparison, not a cap
  const scale = Math.max(amount, limit, 1);
  const within = Math.min(amount, limit);
  const pct = (v: number) => `${((v / scale) * 100).toFixed(2)}%`;
  return (
    <div className={clsx('cursor-pointer px-3 py-2 hover:bg-paper', rowTone(r.flags))} onClick={() => r.nodeId && drawer.open(r.nodeId)}>
      <div className="flex flex-wrap items-baseline gap-x-3">
        <span className="min-w-0 flex-1 font-medium">{r.label}</span>
        <span className="text-xs text-graphite">
          claimed <Num cell={r.cells.amount} /> · limit <Num cell={r.cells.limit} />
          {r.cells.allowed && (
            <>
              {' '}
              · allowed <Num cell={r.cells.allowed} className="font-semibold" />
            </>
          )}
        </span>
        {isChoice ? (
          <Verdict ok>{amount > limit ? 'itemizing is larger' : 'standard is larger'}</Verdict>
        ) : (over ?? 0) > 0 ? (
          <Verdict ok={false}>
            over by <Plain value={over} />
          </Verdict>
        ) : (
          <Verdict ok>within limit</Verdict>
        )}
      </div>
      <div className="relative mt-1 h-2.5 rounded-sm bg-ruleSoft" aria-hidden>
        {isChoice ? (
          <>
            <span className="absolute inset-y-0 left-0 rounded-sm bg-blue/70" style={{ width: pct(amount) }} />
            <span className="absolute -inset-y-0.5 w-0.5 bg-ink" style={{ left: pct(limit) }} />
          </>
        ) : (
          <>
            <span className="absolute inset-y-0 left-0 rounded-sm bg-ledger/70" style={{ width: pct(within) }} />
            {amount > limit && <span className="absolute inset-y-0 rounded-r-sm bg-pencil" style={{ left: pct(limit), width: pct(amount - limit) }} />}
            <span className="absolute -inset-y-0.5 w-0.5 bg-ink" style={{ left: pct(limit) }} title="limit" />
          </>
        )}
      </div>
      {r.cells.limit?.note && <div className="mt-0.5 text-2xs text-faint">Limit: {r.cells.limit.note}</div>}
      {r.flags?.map((f, i) => (
        <FlagText key={i} flag={f} className="mt-0.5" />
      ))}
    </div>
  );
}

export function RetirementForeign({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const f8606 = s.get('8606');
  const ret = s.get('retirement');
  const foreign = s.get('foreign');
  const sep = ret?.rows.find((r) => r.id === 'sep');
  return (
    <div className="space-y-4">
      {sep && (
        <Box title="SEP: contributed vs deductible" note="The deduction is already limited; the excess stays in the plan and owes the 6% excise tax unless withdrawn.">
          <LimitBar r={{ ...sep, label: 'Contributed vs deduction limit (Schedule 1 line 16)', cells: { amount: sep.cells.contributed, limit: sep.cells.amount, allowed: sep.cells.amount, over: sep.cells.excess } }} />
        </Box>
      )}
      {foreign && (
        <Box title={foreign.title} note="Each foreign amount re-converted at the rate the year calls for; the difference is what the rate choice moved.">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-sm">
              <thead>
                <tr className="border-b border-rule text-xs text-graphite">
                  <th className="px-3 py-1.5 text-left font-semibold">Item</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Local</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Rate used</th>
                  <th className="px-2 py-1.5 text-right font-semibold">USD on return</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Correct rate</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Recomputed USD</th>
                  <th className="px-2 py-1.5 text-right font-semibold">Difference</th>
                </tr>
              </thead>
              <tbody>
                {foreign.rows.map((r) => (
                  <FxRow key={r.id} r={r} />
                ))}
              </tbody>
            </table>
          </div>
        </Box>
      )}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {f8606 && (
          <Box title={f8606.title}>
            <LineList rows={f8606.rows} findings={view.findings} />
          </Box>
        )}
        {ret && (
          <Box title={ret.title}>
            <LineList rows={ret.rows.filter((r) => r !== sep)} findings={view.findings} />
          </Box>
        )}
      </div>
      <Rest sections={s.rest(['8606', 'retirement', 'foreign'])} />
    </div>
  );
}

function FxRow({ r }: { r: ViewRow }) {
  const drawer = useDrawer();
  const onReturn = num(r.cells.amount);
  const re = num(r.cells.recomputed);
  const diff = onReturn !== undefined && re !== undefined ? re - onReturn : undefined;
  const rateOff = num(r.cells.rate) !== num(r.cells.preferredRate);
  return (
    <tr className={clsx('cursor-pointer border-b border-ruleSoft align-top last:border-0 hover:bg-paper', rowTone(r.flags))} onClick={() => r.nodeId && drawer.open(r.nodeId)}>
      <td className="px-3 py-1.5">
        {r.label}
        <div className="text-xs text-faint">{r.sublabel}</div>
        {r.flags?.map((f, i) => (
          <FlagText key={i} flag={f} chips={false} className="mt-0.5" />
        ))}
      </td>
      <td className="px-2 py-1.5 text-right">
        <Num cell={r.cells.local} />
      </td>
      <td className={clsx('px-2 py-1.5 text-right', rateOff && 'font-semibold text-amber-ink')}>
        <Num cell={r.cells.rate} kind="ratio" />
      </td>
      <td className="px-2 py-1.5 text-right">
        <Num cell={r.cells.amount} />
      </td>
      <td className="px-2 py-1.5 text-right">
        <Num cell={r.cells.preferredRate} kind="ratio" />
      </td>
      <td className="px-2 py-1.5 text-right">
        <Num cell={r.cells.recomputed} />
      </td>
      <td className={clsx('px-2 py-1.5 text-right', diff && Math.abs(diff) >= 1 ? 'font-semibold text-pencil-ink' : 'text-faint')}>{diff === undefined ? '' : <Plain value={Math.round(diff)} />}</td>
    </tr>
  );
}
