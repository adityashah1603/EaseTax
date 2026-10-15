// State split: the residency timeline, then Schedule CA (540NR) columns A–E with each
// line's sourcing method and our column-math check (A − B + C = D; E within D).
import type { ViewDto, ViewRow } from '@easetax/shared';
import clsx from 'clsx';
import { useDrawer } from '../../state/drawer';
import { Box, FlagText, Num, Pill, Plain, Rest, Verdict, num, rowTone, sectionsOf, type Tone } from './kit';

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

function method(text: string): { label: string; tone: Tone } {
  if (/prorated by days/i.test(text)) return { label: 'days-based', tone: 'adj' };
  if (/100% California-source/i.test(text)) return { label: 'by property location', tone: 'ok' };
  if (/work location|where the work/i.test(text)) return { label: 'by work location & date', tone: 'warn' };
  if (/residency at sale|received while a resident/i.test(text)) return { label: 'by residency at the event', tone: 'adj' };
  if (/follow the income/i.test(text)) return { label: 'follows related income', tone: 'info' };
  return { label: text ? 'per rule' : 'engine sum', tone: 'none' };
}

export function StateSplit({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const res = s.get('residency');
  const sch = s.get('schca');
  const wages = s.get('wage-evidence');
  const meta = (view.meta ?? {}) as { caDays?: number; yearDays?: number; ratio?: number };
  return (
    <div className="space-y-4">
      {res && <Timeline rows={res.rows} yearDays={meta.yearDays ?? 365} />}
      {sch && <ScheduleCA rows={sch.rows} totals={sch.totals ?? []} note={sch.note} ratio={meta.ratio} findings={view.findings} />}
      {wages && (
        <Box title={wages.title} note="What the documents say about where wages were earned. Box 16 reports California wages for the full year; the paystub gives the amount through the move.">
          <ul className="divide-y divide-ruleSoft text-sm">
            {wages.rows.map((r) => (
              <WageRow key={r.id} r={r} />
            ))}
          </ul>
        </Box>
      )}
      <Rest sections={s.rest(['residency', 'schca', 'wage-evidence'])} />
    </div>
  );
}

function WageRow({ r }: { r: ViewRow }) {
  const drawer = useDrawer();
  return (
    <li className={clsx('flex cursor-pointer items-center gap-3 px-3 py-1 hover:bg-paper', /through/i.test(r.label) && 'bg-blue-soft/40')} onClick={() => r.nodeId && drawer.open(r.nodeId)}>
      <span className="w-[40px] text-2xs text-faint">{r.sublabel}</span>
      <span className="min-w-0 flex-1 truncate">{r.label}</span>
      <Num cell={r.cells.amount} kind={typeof r.cells.amount?.value === 'number' ? 'money' : 'text'} />
    </li>
  );
}

function Timeline({ rows, yearDays }: { rows: ViewRow[]; yearDays: number }) {
  return (
    <Box title="Residency 2025" note="California part-year resident; every California-source decision below hangs on these dates.">
      <div className="p-3">
        <div className="flex h-9 overflow-hidden rounded border border-rule">
          {rows.map((r, i) => {
            const days = num(r.cells.days) ?? 0;
            const ca = /^CA/.test(r.label);
            return (
              <div key={r.id} className={clsx('flex flex-col justify-center px-2 text-xs', ca ? 'bg-ledger text-white' : 'bg-blue-soft text-blue-ink', i > 0 && 'border-l-2 border-panel')} style={{ width: `${(days / yearDays) * 100}%` }} title={`${r.label} ${r.sublabel}`}>
                <span className="truncate font-semibold">{r.label}</span>
                <span className="num truncate text-2xs opacity-90">
                  {r.sublabel} · {days} days ({num(r.cells.share)?.toFixed(2)}%)
                </span>
              </div>
            );
          })}
        </div>
        <div className="mt-1 grid grid-cols-12 text-2xs text-faint" aria-hidden>
          {MONTHS.map((m, i) => (
            <span key={i} className="border-l border-rule pl-1">
              {m}
            </span>
          ))}
        </div>
      </div>
    </Box>
  );
}

function ScheduleCA({ rows, totals, note, ratio, findings }: { rows: ViewRow[]; totals: ViewRow[]; note?: string; ratio?: number; findings: ViewDto['findings'] }) {
  const drawer = useDrawer();
  const failures = rows.filter((r) => {
    const d = num(r.cells.D);
    const rd = num(r.cells.recalcD);
    return d !== undefined && rd !== undefined && Math.abs(d - rd) >= 1;
  }).length;
  const cols = ['A', 'B', 'C', 'D', 'E'] as const;
  const colTitle: Record<string, string> = { A: 'A Federal', B: 'B Subtract', C: 'C Add', D: 'D CA law', E: 'E CA source' };
  return (
    <Box title="Schedule CA (540NR)" note={note} right={<Verdict ok={failures === 0}>{failures === 0 ? 'column math checks: A − B + C = D on every line' : `${failures} line(s) fail A − B + C = D`}</Verdict>}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[980px] text-sm">
          <thead>
            <tr className="border-b border-rule text-xs text-graphite">
              <th className="px-3 py-1.5 text-left font-semibold">Line · sourcing</th>
              {cols.map((c) => (
                <th key={c} className={clsx('px-2 py-1.5 text-right font-semibold', c === 'E' && 'bg-ledger-soft text-ledger-ink')}>
                  {colTitle[c]}
                </th>
              ))}
              <th className="px-2 py-1.5 text-left font-semibold">A − B + C = D</th>
              <th className="px-2 py-1.5 text-left font-semibold">E within D</th>
              <th className="px-2 py-1.5 text-right font-semibold" title="D prorated by California days: a reference, not the rule for every line">
                D × CA days
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const m = String(r.cells.method?.value ?? '');
              const mt = method(m);
              const d = num(r.cells.D);
              const e = num(r.cells.E);
              const rd = num(r.cells.recalcD);
              const mathOk = rd === undefined || d === undefined ? null : Math.abs(d - rd) < 1;
              const within = d === undefined || e === undefined ? null : Math.abs(e) <= Math.abs(d) + 0.5 && (d === 0 || Math.sign(e) === Math.sign(d) || e === 0);
              const extra = findings.filter((f) => f.nodeIds?.some((n) => Object.values(r.cells).some((c) => c?.nodeId === n)) && !(r.flags ?? []).some((x) => x.code === f.code));
              const flags = [...(r.flags ?? []), ...extra];
              return (
                <tr key={r.id} className={clsx('cursor-pointer border-b border-ruleSoft align-top hover:bg-paper', rowTone(flags))} onClick={() => r.nodeId && drawer.open(r.nodeId)}>
                  <td className="px-3 py-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{r.label}</span>
                      <Pill tone={mt.tone} title={m}>
                        {mt.label}
                      </Pill>
                    </div>
                    {m && <div className="max-w-[380px] text-xs text-faint">{m}</div>}
                    {flags.map((f, i) => (
                      <FlagText key={i} flag={f} className="mt-0.5 max-w-[420px]" />
                    ))}
                  </td>
                  {cols.map((c) => (
                    <td key={c} className={clsx('px-2 py-1.5 text-right', c === 'E' && 'bg-ledger-soft/50 font-semibold')}>
                      <Num cell={r.cells[c]} />
                    </td>
                  ))}
                  <td className="px-2 py-1.5">{mathOk === null ? <span className="text-xs text-faint">n/a</span> : <Verdict ok={mathOk}>{mathOk ? 'ok' : <Plain value={rd} />}</Verdict>}</td>
                  <td className="px-2 py-1.5">{within === null ? null : <Verdict ok={within}>{within ? 'ok' : 'E exceeds D'}</Verdict>}</td>
                  <td className="px-2 py-1.5 text-right text-graphite">
                    <Num cell={r.cells.prorated} />
                    {mt.label !== 'days-based' && e !== undefined && num(r.cells.prorated) !== undefined && Math.abs(e - num(r.cells.prorated)!) >= 1 && (
                      <div className="text-2xs text-faint">
                        E is <Plain value={e - num(r.cells.prorated)!} /> vs days
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
            {totals.map((t) => (
              <tr key={t.id} className="border-t-2 border-ink font-semibold">
                <td className="px-3 py-1.5">{t.label}</td>
                {cols.map((c) => (
                  <td key={c} className={clsx('px-2 py-1.5 text-right', c === 'E' && 'bg-ledger-soft/50')}>
                    <Num cell={t.cells[c]} />
                  </td>
                ))}
                <td className="px-2 py-1.5" colSpan={2}>
                  {num(t.cells.recalcD) !== undefined && num(t.cells.E) !== undefined && <Verdict ok={Math.abs(num(t.cells.recalcD)! - num(t.cells.E)!) < 1}>recomputed <Plain value={num(t.cells.recalcD)} /></Verdict>}
                </td>
                <td className="px-2 py-1.5 text-right text-xs font-normal text-graphite">{ratio !== undefined && `CA days ${(ratio * 100).toFixed(2)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Box>
  );
}
