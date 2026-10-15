// Depreciation by asset: each asset's federal, California and AMT depreciation side by
// side, grouped by activity, with the register-to-return check at the top of each group.
import type { ViewCell, ViewDto, ViewRow, ViewSection } from '@easetax/shared';
import clsx from 'clsx';
import { useDrawer } from '../../state/drawer';
import { Box, FlagText, Num, Pill, Rest, Verdict, num, sectionsOf } from './kit';

const activityOf = (r: ViewRow) => (r.sublabel ?? '').split(' · ')[0] ?? 'Other';

export function Depreciation({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const assets = s.get('assets');
  const lines = s.get('lines');
  const disposals = s.get('disposals');
  const caBasis = s.get('ca-basis');
  const groups = new Map<string, ViewRow[]>();
  for (const r of assets?.rows ?? []) groups.set(activityOf(r), [...(groups.get(activityOf(r)) ?? []), r]);
  const lineByActivity = new Map((lines?.rows ?? []).map((r) => [r.id, r]));
  const diffs = (assets?.rows ?? []).filter((r) => num(r.cells.fed2025) !== num(r.cells.ca2025)).length;

  return (
    <div className="space-y-4">
      <p className="text-xs text-graphite">
        {assets?.rows.length ?? 0} assets in {groups.size} activities. {diffs} asset(s) depreciate differently for California than federal (bonus and §179 do not conform) — those
        columns are tinted. Every amount opens the asset or the prior-year record behind it.
      </p>
      {[...groups.entries()].map(([activity, rows]) => (
        <ActivityGroup key={activity} activity={activity} rows={rows} line={lineByActivity.get(activity)} />
      ))}
      {disposals && <Reconciliation section={disposals} />}
      {caBasis && (
        <Box title={caBasis.title} note="Federal/California basis differences that carry into 2026 (they reverse through California depreciation).">
          <ul className="divide-y divide-ruleSoft text-sm">
            {caBasis.rows.map((r) => (
              <li key={r.id} className="flex items-center justify-between px-3 py-1.5">
                <span>{r.label}</span>
                <Num cell={r.cells.amount} />
              </li>
            ))}
          </ul>
        </Box>
      )}
      <Rest sections={s.rest(['assets', 'lines', 'disposals', 'ca-basis'])} />
    </div>
  );
}

function ActivityGroup({ activity, rows, line }: { activity: string; rows: ViewRow[]; line?: ViewRow }) {
  const diff = num(line?.cells.difference);
  return (
    <Box
      title={activity}
      right={
        line && (
          <span className="flex items-center gap-2 text-xs text-graphite">
            Register <Num cell={line.cells.register} /> vs return line <Num cell={line.cells.line} />
            <Verdict ok={diff !== undefined && Math.abs(diff) < 1}>{diff !== undefined && Math.abs(diff) < 1 ? (diff ? 'agrees (rounding)' : 'agrees') : `differs ${diff}`}</Verdict>
          </span>
        )
      }
    >
      <div className="divide-y divide-rule">
        {rows.map((r) => (
          <AssetCard key={r.id} r={r} />
        ))}
      </div>
    </Box>
  );
}

function AssetCard({ r }: { r: ViewRow }) {
  const drawer = useDrawer();
  const c = r.cells;
  const differs = num(c.fed2025) !== num(c.ca2025) || num(c.fedEnd) !== num(c.caEnd);
  const disposed = /disposed/i.test(r.status ?? '');
  const parts = (r.sublabel ?? '').split(' · ').slice(1);
  const has = (cell: ViewCell | undefined) => cell && cell.value !== null && cell.value !== undefined;
  const rec1250 = num(c.recapture1250);
  const recOrd = num(c.ordinaryRecapture);
  return (
    <div className={clsx('grid grid-cols-1 gap-3 px-3 py-2.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]', disposed && 'bg-paper')}>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <button className="text-left font-semibold hover:text-blue-ink hover:underline" onClick={() => r.nodeId && drawer.open(r.nodeId)}>
            {r.label}
          </button>
          <Pill tone={disposed ? 'warn' : 'info'}>{r.status}</Pill>
          {(num(c.bonus) ?? 0) > 0 && <Pill tone="adj">bonus {Math.round(num(c.bonus)!).toLocaleString('en-US')}</Pill>}
          {(num(c.s179) ?? 0) > 0 && <Pill tone="adj">§179 {Math.round(num(c.s179)!).toLocaleString('en-US')}</Pill>}
        </div>
        <div className="mt-0.5 text-xs text-graphite">{parts.join(' · ')}</div>
        <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          <dt className="text-faint">Cost</dt>
          <dd>
            <Num cell={c.cost} />
            {has(c.land) && (
              <span className="text-faint">
                {' '}
                (land <Num cell={c.land} /> not depreciated)
              </span>
            )}
          </dd>
          <dt className="text-faint">Method</dt>
          <dd className="text-graphite">
            {String(c.method?.value ?? '—')}
            {has(c.life) && ` · ${c.life!.value} yr`}
          </dd>
          {(rec1250 || recOrd !== undefined) && disposed && (
            <>
              <dt className="text-faint">Recapture</dt>
              <dd>
                unrecaptured §1250 <Num cell={c.recapture1250} /> · ordinary <Num cell={c.ordinaryRecapture} />
              </dd>
            </>
          )}
        </dl>
        {r.flags?.map((f, i) => <FlagText key={i} flag={f} className="mt-1" />)}
      </div>
      <table className="w-full self-start text-sm">
        <thead>
          <tr className="text-2xs text-graphite">
            <th className="py-0.5 text-left font-semibold" />
            <th className="px-2 py-0.5 text-right font-semibold">Federal</th>
            <th className={clsx('px-2 py-0.5 text-right font-semibold', differs && 'bg-amber-soft text-amber-ink')}>California</th>
            <th className="px-2 py-0.5 text-right font-semibold">AMT</th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-ruleSoft">
            <td className="py-0.5 text-xs text-faint">Accumulated 1/1</td>
            <td className="px-2 text-right">
              <Num cell={c.fedPrior} />
            </td>
            <td className={clsx('px-2 text-right', differs && 'bg-amber-soft/50')}>
              <Num cell={c.caPrior} />
            </td>
            <td className="px-2 text-right text-faint">—</td>
          </tr>
          <tr className="border-t border-ruleSoft font-semibold">
            <td className="py-0.5 text-xs font-normal text-faint">2025 depreciation</td>
            <td className="px-2 text-right">
              <Num cell={c.fed2025} />
            </td>
            <td className={clsx('px-2 text-right', differs && 'bg-amber-soft/50')}>
              <Num cell={c.ca2025} />
            </td>
            <td className="px-2 text-right">
              <Num cell={c.amt2025} />
            </td>
          </tr>
          <tr className="border-t border-ruleSoft">
            <td className="py-0.5 text-xs text-faint">Accumulated 12/31</td>
            <td className="px-2 text-right">
              <Num cell={c.fedEnd} />
            </td>
            <td className={clsx('px-2 text-right', differs && 'bg-amber-soft/50')}>
              <Num cell={c.caEnd} />
            </td>
            <td className="px-2 text-right text-xs text-graphite">
              adj <Num cell={c.amtDiff} />
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Reconciliation({ section }: { section: ViewSection }) {
  return (
    <Box title={section.title} note="The asset register recomputed against the return lines it should feed.">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-rule text-xs text-graphite">
            <th className="px-3 py-1.5 text-left font-semibold">Line</th>
            <th className="px-2 py-1.5 text-right font-semibold">Asset register</th>
            <th className="px-2 py-1.5 text-right font-semibold">Return line</th>
            <th className="px-2 py-1.5 text-right font-semibold">Difference</th>
            <th className="px-3 py-1.5 text-left font-semibold">Check</th>
          </tr>
        </thead>
        <tbody>
          {section.rows.map((r) => {
            const d = num(r.cells.difference) ?? 0;
            return (
              <tr key={r.id} className="border-b border-ruleSoft last:border-0">
                <td className="px-3 py-1.5">
                  {r.label} <span className="text-xs text-faint">{r.id}</span>
                </td>
                <td className="px-2 py-1.5 text-right">
                  <Num cell={r.cells.register} />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <Num cell={r.cells.line} />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <Num cell={r.cells.difference} kind="cents" />
                </td>
                <td className="px-3 py-1.5">
                  <Verdict ok={Math.abs(d) < 1}>{Math.abs(d) < 1 ? (d ? 'agrees (rounding)' : 'agrees') : 'differs'}</Verdict>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Box>
  );
}
