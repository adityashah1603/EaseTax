// Payments: what the return claims against what the IRS and FTB actually hold.
import type { ViewDto, ViewRow, ViewSection } from '@easetax/shared';
import clsx from 'clsx';
import { useDrawer } from '../../state/drawer';
import { Box, FlagText, NodeChips, Num, Plain, Rest, Verdict, num, rowTone, sectionsOf } from './kit';

interface Agg {
  claimed: number;
  record: number;
  difference: number;
  agreed: boolean;
}

export function Payments({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const meta = (view.meta ?? {}) as { federal?: Agg; california?: Agg };
  const fed = s.get('federal');
  const ca = s.get('california');
  const wh = s.get('withholding');
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {meta.federal && <Totals title="Federal estimates: claimed vs IRS transcript" a={meta.federal} />}
        {meta.california && <Totals title="California estimates: claimed vs FTB account" a={meta.california} />}
      </div>
      {fed && <PaymentTable section={fed} agency="IRS" />}
      {ca && <PaymentTable section={ca} agency="FTB" />}
      {wh && (
        <Box title={wh.title} note="No agency record for withholding; it is agreed to the W-2s behind each line.">
          <ul className="divide-y divide-ruleSoft text-sm">
            {wh.rows.map((r) => (
              <WithholdingRow key={r.id} r={r} />
            ))}
          </ul>
        </Box>
      )}
      <Rest sections={s.rest(['federal', 'california', 'withholding'])} />
    </div>
  );
}

function Totals({ title, a }: { title: string; a: Agg }) {
  return (
    <div className={clsx('rounded border px-3 py-2', a.agreed ? 'border-ledger/40 bg-ledger-soft/40' : 'border-pencil/50 bg-pencil-soft/40')}>
      <div className="text-xs font-semibold text-graphite">{title}</div>
      <div className="mt-1 flex items-baseline gap-4">
        <span>
          <span className="text-2xs text-graphite">claimed </span>
          <Plain value={a.claimed} className="text-lg font-semibold" />
        </span>
        <span>
          <span className="text-2xs text-graphite">on record </span>
          <Plain value={a.record} className="text-lg font-semibold" />
        </span>
        <span className="flex-1" />
        <Verdict ok={a.agreed}>{a.agreed ? 'agrees' : <>overstated by <Plain value={a.difference} /></>}</Verdict>
      </div>
    </div>
  );
}

function PaymentTable({ section, agency }: { section: ViewSection; agency: string }) {
  const drawer = useDrawer();
  return (
    <Box title={section.title} note={`Each claimed payment matched to the ${agency} record by date and amount.`}>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-rule text-xs text-graphite">
            <th className="px-3 py-1.5 text-left font-semibold">Payment</th>
            <th className="px-2 py-1.5 text-left font-semibold">Date claimed</th>
            <th className="px-2 py-1.5 text-right font-semibold">Claimed</th>
            <th className="px-2 py-1.5 text-left font-semibold">Date per {agency}</th>
            <th className="px-2 py-1.5 text-right font-semibold">Per {agency}</th>
            <th className="px-2 py-1.5 text-right font-semibold">Difference</th>
          </tr>
        </thead>
        <tbody>
          {section.rows.map((r) => {
            const diff = num(r.cells.difference) ?? 0;
            const dateDiffers = !!r.cells.recordDate?.value && !!r.cells.claimedDate?.value && r.cells.recordDate!.value !== r.cells.claimedDate!.value;
            return (
              <tr key={r.id} className={clsx('cursor-pointer border-b border-ruleSoft align-top last:border-0 hover:bg-paper', rowTone(r.flags))} onClick={() => r.nodeId && drawer.open(r.nodeId)}>
                <td className="px-3 py-1.5">
                  {r.label}
                  <div className="text-xs text-faint">{r.sublabel}</div>
                  {r.flags?.map((f, i) => (
                    <FlagText key={i} flag={f} className="mt-0.5 max-w-[520px]" />
                  ))}
                </td>
                <td className="px-2 py-1.5">
                  <Num cell={r.cells.claimedDate} kind="date" />
                </td>
                <td className="px-2 py-1.5 text-right">
                  <Num cell={r.cells.claimed} />
                </td>
                <td className={clsx('px-2 py-1.5', dateDiffers && 'font-semibold text-amber-ink')}>{r.cells.recordDate?.value ? <Num cell={r.cells.recordDate} kind="date" /> : <span className="text-xs text-pencil-ink">no matching payment</span>}</td>
                <td className="px-2 py-1.5 text-right">
                  <Num cell={r.cells.record} />
                </td>
                <td className={clsx('px-2 py-1.5 text-right', Math.abs(diff) >= 1 ? 'font-semibold text-pencil-ink' : 'text-faint')}>
                  <Num cell={r.cells.difference} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Box>
  );
}

function WithholdingRow({ r }: { r: ViewRow }) {
  const drawer = useDrawer();
  return (
    <li className="flex cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-paper" onClick={() => r.nodeId && drawer.open(r.nodeId)}>
      <span className="min-w-0 flex-1">
        {r.label} <span className="text-xs text-faint">{(r.sublabel ?? '').split(' · ')[0]}</span>
      </span>
      <NodeChips ids={r.links} max={4} />
      <Num cell={r.cells.claimed} className="w-[100px] text-right" />
    </li>
  );
}
