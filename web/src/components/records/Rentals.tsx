// Rentals and passive losses, and K-1 lines.
import type { ViewDto, ViewFlag, ViewRow, ViewSection } from '@easetax/shared';
import clsx from 'clsx';
import { ArrowRight } from 'lucide-react';
import { useDrawer } from '../../state/drawer';
import { Box, FlagText, NodeChip, Num, Pill, Rest, Verdict, num, rowTone, sectionsOf } from './kit';

const isTotal = (r: ViewRow) => /^(Total|Income or \(loss\)|Combine|Net section|Section 1231 gain to|Total gain|Adjusted basis)/i.test(r.label);

/** A list of return lines in order, totals ruled off; used for small schedules. */
export function LineList({ rows, findings = [] }: { rows: ViewRow[]; findings?: ViewFlag[] }) {
  const drawer = useDrawer();
  return (
    <ul className="text-sm">
      {rows.map((r) => {
        const extra = findings.filter((f) => r.nodeId && f.nodeIds?.includes(r.nodeId) && !(r.flags ?? []).some((x) => x.code === f.code));
        const flags = [...(r.flags ?? []), ...extra];
        const cell = r.cells.amount ?? Object.values(r.cells).find(Boolean);
        return (
          <li key={r.id} className={clsx('cursor-pointer px-3 py-1 hover:bg-paper', isTotal(r) && 'border-t border-rule font-semibold', rowTone(flags))} onClick={() => r.nodeId && drawer.open(r.nodeId)}>
            <div className="flex items-baseline gap-2">
              <span className="w-[74px] shrink-0 text-2xs font-normal text-faint">{r.sublabel}</span>
              <span className="min-w-0 flex-1 truncate" title={r.label}>
                {r.label}
              </span>
              <Num cell={cell} className="shrink-0" />
            </div>
            {flags.map((f, i) => (
              <FlagText key={i} flag={f} className="ml-[82px]" />
            ))}
          </li>
        );
      })}
    </ul>
  );
}

export function Rentals({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const props = view.sections.filter((x) => x.id.startsWith('property-'));
  const passive = s.get('passive');
  const sale = s.get('sale');
  return (
    <div className="space-y-4">
      {props.map((p) => (
        <Property key={p.id} section={p} findings={view.findings} />
      ))}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {passive && (
          <Box title={passive.title} note="Net income from the sale frees the suspended losses.">
            <LineList rows={passive.rows} findings={view.findings} />
          </Box>
        )}
        {sale && (
          <Box title={sale.title}>
            <LineList rows={sale.rows} findings={view.findings} />
          </Box>
        )}
      </div>
      <Rest sections={s.rest([...props.map((p) => p.id), 'passive', 'sale'])} />
    </div>
  );
}

function Property({ section, findings }: { section: ViewSection; findings: ViewFlag[] }) {
  const lines = section.rows.filter((r) => r.nodeId?.startsWith('line:'));
  const flow = ['in', 'cur', 'allowed', 'out'].map((p) => section.rows.find((r) => r.id.startsWith(`${p}:`)));
  const days = lines.find((r) => /Days rented/i.test(r.label));
  const body = lines.filter((r) => r !== days);
  const net = body.find((r) => /Income or \(loss\)/i.test(r.label));
  return (
    <Box title={section.title} right={days && <span className="text-xs text-graphite">Days rented / personal: <Num cell={days.cells.amount} kind="text" /></span>}>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="border-b border-rule py-1 lg:border-b-0 lg:border-r">
          <LineList rows={body} findings={findings} />
        </div>
        <div className="p-3">
          <h3 className="mb-2 text-xs font-semibold text-graphite">Passive loss carryforward</h3>
          <div className="flex flex-wrap items-stretch gap-1.5">
            {flow.map((r, i) =>
              r ? (
                <div key={r.id} className="flex items-center gap-1.5">
                  {i > 0 && <ArrowRight size={14} className="text-faint" />}
                  <div className={clsx('rounded border px-2 py-1', i === 3 ? 'border-ink' : 'border-rule')}>
                    <div className="text-2xs text-graphite">{r.label}</div>
                    <Num cell={r.cells.amount} className="font-semibold" />
                    {r.cells.check && (
                      <div className="text-2xs">
                        <Verdict ok={num(r.cells.check) === num(r.cells.amount)}>recomputed <Num cell={r.cells.check} /></Verdict>
                      </div>
                    )}
                  </div>
                </div>
              ) : null,
            )}
          </div>
          {net && <p className="mt-3 text-xs text-graphite">2025 result per Schedule E: <Num cell={net.cells.amount} />. Suspended losses from 2024 are released against passive income, including the rental sale gain.</p>}
        </div>
      </div>
    </Box>
  );
}

export function K1({ view }: { view: ViewDto }) {
  const drawer = useDrawer();
  return (
    <div className="space-y-4">
      {view.sections.map((sec) => {
        const unlanded = sec.rows.filter((r) => !r.cells.landed?.value).length;
        return (
          <Box key={sec.id} title={sec.title} note={sec.note} right={<span className="text-xs text-graphite">{sec.rows.length} K-1 values{unlanded ? ` · ${unlanded} not on any line` : ''}</span>}>
            <div className="grid grid-cols-[minmax(0,1.2fr)_100px_20px_minmax(0,1fr)_110px_110px] items-center gap-2 border-b border-rule px-3 py-1.5 text-xs font-semibold text-graphite">
              <span>K-1 box</span>
              <span className="text-right">K-1 amount</span>
              <span />
              <span>Landed on</span>
              <span className="text-right">Line (effective)</span>
              <span>Check</span>
            </div>
            {sec.rows.map((r) => {
              const flags = [...(r.flags ?? []), ...view.findings.filter((f) => r.nodeId && f.nodeIds?.includes(r.nodeId))];
              const a = num(r.cells.amount);
              const b = num(r.cells.landedValue);
              const landedIds = (r.links ?? []).filter((x) => x.startsWith('line:'));
              const same = a !== undefined && b !== undefined && Math.abs(Math.abs(a) - Math.abs(b)) < 1;
              return (
                <div key={r.id} className={clsx('cursor-pointer border-b border-ruleSoft px-3 py-1 last:border-0 hover:bg-paper', rowTone(flags))} onClick={() => r.nodeId && drawer.open(r.nodeId)}>
                  <div className="grid grid-cols-[minmax(0,1.2fr)_100px_20px_minmax(0,1fr)_110px_110px] items-center gap-2 text-sm">
                    <span className="min-w-0 truncate" title={r.label}>
                      {r.label} <span className="text-xs text-faint">{r.sublabel}</span>
                    </span>
                    <Num cell={r.cells.amount} kind={typeof r.cells.amount?.value === 'number' ? 'money' : 'text'} className="text-right" />
                    <ArrowRight size={13} className="text-faint" />
                    <span className="flex min-w-0 flex-wrap gap-1">{landedIds.length ? landedIds.map((id) => <NodeChip key={id} id={id} />) : <Pill tone="warn">not on a 2025 line</Pill>}</span>
                    <Num cell={r.cells.landedValue} className="text-right" />
                    <span>
                      {b === undefined || a === undefined ? null : same ? (
                        <Verdict ok>agrees</Verdict>
                      ) : Math.abs(b) > Math.abs(a) ? (
                        <span className="text-2xs text-graphite" title="The line combines this K-1 value with other items">line holds more</span>
                      ) : (
                        <Verdict ok={false} warn>
                          line differs
                        </Verdict>
                      )}
                    </span>
                  </div>
                  {flags.map((f, i) => (
                    <FlagText key={i} flag={f} />
                  ))}
                </div>
              );
            })}
          </Box>
        );
      })}
    </div>
  );
}
