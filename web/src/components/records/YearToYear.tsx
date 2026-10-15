// Records that cross years: carryovers, basis by year, and the prior preparer's file vs us.
import type { ViewDto, ViewRow, ViewSection } from '@easetax/shared';
import clsx from 'clsx';
import { ArrowRight } from 'lucide-react';
import { useDrawer } from '../../state/drawer';
import { Box, FlagText, NodeChips, Num, Pill, Rest, Verdict, num, rowTone, sectionsOf, type Tone } from './kit';

// ------------------------------------------------------------------ carryovers

export function Carryovers({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const fed = s.get('federal');
  const ca = s.get('california');
  const agree = s.get('agreement');
  return (
    <div className="space-y-4">
      {fed && <CarryTable section={fed} findings={view.findings} />}
      {ca && <CarryTable section={ca} findings={view.findings} />}
      {agree && (
        <Box title={agree.title} note="Opening balances agreed to the 2024 record. Losses are negative on the return and positive in the record.">
          <ul className="divide-y divide-ruleSoft text-sm">
            {agree.rows.map((r) => {
              const a = num(r.cells.line);
              const b = num(r.cells.prior);
              const ok = a !== undefined && b !== undefined && Math.abs(Math.abs(a) - Math.abs(b)) < 1;
              return (
                <AgreeRow key={r.id} r={r} ok={ok} />
              );
            })}
          </ul>
        </Box>
      )}
      <Rest sections={s.rest(['federal', 'california', 'agreement'])} />
    </div>
  );
}

function AgreeRow({ r, ok }: { r: ViewRow; ok: boolean }) {
  const drawer = useDrawer();
  return (
    <li className="flex cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-paper" onClick={() => r.nodeId && drawer.open(r.nodeId)}>
      <span className="min-w-0 flex-1 truncate">{r.label}</span>
      <span className="text-xs text-graphite">2024</span>
      <Num cell={r.cells.prior} className="w-[90px] text-right" />
      <ArrowRight size={12} className="text-faint" />
      <span className="text-xs text-graphite">2025</span>
      <Num cell={r.cells.line} className="w-[90px] text-right" />
      <span className="w-[200px]">
        <Verdict ok={ok}>{r.status ?? (ok ? 'agrees' : 'differs')}</Verdict>
      </span>
    </li>
  );
}

function CarryTable({ section, findings }: { section: ViewSection; findings: ViewDto['findings'] }) {
  const drawer = useDrawer();
  const unused = section.rows.filter((r) => /not cited/i.test(r.sublabel ?? '')).length;
  return (
    <Box title={section.title} right={unused ? <Pill tone="warn">{unused} carried in but not used on any 2025 line</Pill> : undefined}>
      <div className="grid grid-cols-[minmax(0,1fr)_110px_24px_minmax(0,1.1fr)_24px_110px] gap-2 border-b border-rule px-3 py-1.5 text-xs font-semibold text-graphite">
        <span>Carryover</span>
        <span className="text-right">In from 2024</span>
        <span />
        <span className="text-right">Used in 2025 (line, effective)</span>
        <span />
        <span className="text-right">Out to 2026</span>
      </div>
      {section.rows.map((r) => {
        const notCited = /not cited/i.test(r.sublabel ?? '');
        const flags = [...(r.flags ?? []), ...findings.filter((f) => f.nodeIds?.some((n) => r.links?.includes(n) || n === r.nodeId))];
        return (
          <div key={r.id} className={clsx('cursor-pointer border-b border-ruleSoft px-3 py-1 last:border-0 hover:bg-paper', notCited ? 'bg-amber-soft/30' : rowTone(flags))} onClick={() => r.nodeId && drawer.open(r.nodeId)}>
            <div className="grid grid-cols-[minmax(0,1fr)_110px_24px_minmax(0,1.1fr)_24px_110px] items-center gap-2 text-sm">
              <span className="min-w-0 truncate capitalize" title={r.label}>
                {r.label}
              </span>
              <Num cell={r.cells.in} className="text-right" />
              <ArrowRight size={12} className="text-faint" />
              <span className="text-right">
                {r.cells.used ? (
                  <>
                    <Num cell={r.cells.used} /> <span className="text-2xs text-faint">{(r.sublabel ?? '').replace(/^used on /, '')}</span>
                  </>
                ) : (
                  <span className="text-xs text-amber-ink">{r.sublabel}</span>
                )}
              </span>
              <ArrowRight size={12} className="text-faint" />
              <span className="text-right" title={r.cells.out?.note}>
                <Num cell={r.cells.out} />
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
}

// ------------------------------------------------------------------ basis

export function Basis({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const scorp = s.get('scorp');
  const part = s.get('partnership');
  const ira = s.get('ira');
  return (
    <div className="space-y-4">
      {scorp && (
        <YearStrip
          section={scorp}
          note="Beginning + income − distributions = ending, year by year. Distributions beyond basis are gain."
          fields={[
            ['begin', 'Beginning'],
            ['income', '+ Income'],
            ['distributions', '− Distributions'],
            ['recorded', 'Recorded ending'],
            ['computed', 'Computed ending'],
            ['excess', 'Excess distributions'],
          ]}
        />
      )}
      {part && (
        <YearStrip
          section={part}
          note="Capital account per the K-1, and outside basis, which nobody has computed."
          fields={[
            ['begin', 'Beginning capital'],
            ['capital', 'Ending capital'],
            ['computed', 'Recomputed ending'],
            ['outside', 'Outside basis'],
          ]}
        />
      )}
      {ira && (
        <YearStrip section={ira} note="Nondeductible IRA basis on Form 8606, from the 2024 record into 2025 and out to 2026." fields={[['basis', 'Basis']]} />
      )}
      <Rest sections={s.rest(['scorp', 'partnership', 'ira'])} />
    </div>
  );
}

function YearStrip({ section, fields, note }: { section: ViewSection; fields: [string, string][]; note: string }) {
  const drawer = useDrawer();
  const gaps = section.rows.filter((r) => isGap(r)).length;
  return (
    <Box title={section.title} note={note} right={gaps ? <Pill tone="warn">{gaps} gap(s) in the record</Pill> : undefined}>
      <div className="flex gap-2 overflow-x-auto p-3">
        {section.rows.map((r, i) => {
          const gap = isGap(r);
          return (
            <div key={r.id} className="flex items-stretch gap-2">
              {i > 0 && <ArrowRight size={14} className="mt-8 shrink-0 text-faint" />}
              <div
                className={clsx(
                  'w-[200px] shrink-0 cursor-pointer rounded border p-2 hover:border-blue',
                  gap ? 'border-dashed border-amber bg-amber-soft/40' : worstTone(r) === 'bad' ? 'border-pencil bg-pencil-soft/30' : 'border-rule bg-panel',
                )}
                onClick={() => r.nodeId && drawer.open(r.nodeId)}
              >
                <div className="font-semibold">{r.label}</div>
                {r.sublabel && <div className={clsx('text-2xs', gap ? 'font-semibold text-amber-ink' : 'text-faint')}>{r.sublabel}</div>}
                <dl className="mt-1.5 space-y-0.5 text-xs">
                  {fields
                    .filter(([k]) => r.cells[k] !== undefined)
                    .map(([k, label]) => {
                      const c = r.cells[k];
                      const missing = c?.value === null || c?.value === undefined;
                      const bad = (k === 'excess' && (num(c) ?? 0) > 0) || (k === 'outside' && missing);
                      return (
                        <div key={k} className={clsx('flex justify-between gap-2', (k === 'computed' || k === 'capital') && 'border-t border-ruleSoft pt-0.5 font-semibold')}>
                          <dt className="text-graphite">{label}</dt>
                          <dd className={clsx(bad && 'font-semibold text-pencil-ink')}>{missing ? <span className={clsx(bad ? 'text-pencil-ink' : 'text-faint')}>{bad ? 'not computed' : 'none'}</span> : <Num cell={c} />}</dd>
                        </div>
                      );
                    })}
                </dl>
                {r.flags?.map((f, j) => (
                  <FlagText key={j} flag={f} chips={false} className="mt-1" />
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Box>
  );
}

const isGap = (r: ViewRow) => /missing|not rolled|never computed/i.test(r.sublabel ?? '') || r.flags?.some((f) => /GAP|NOT_ROLLED|MISSING/.test(f.code));
const worstTone = (r: ViewRow): Tone => (r.flags?.some((f) => f.severity === 'error') ? 'bad' : 'none');

// ------------------------------------------------------------------ prior preparer

function statusTone(s?: string): Tone {
  if (!s) return 'none';
  if (/unresolved|open|not addressed/i.test(s)) return 'bad';
  if (/not yet reviewed/i.test(s)) return 'warn';
  if (/resolved|agrees|done|reviewed/i.test(s)) return 'ok';
  return 'info';
}

export function PriorPreparer({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const memo = s.get('memo');
  const open = s.get('open-items');
  const notes = s.get('notes');
  return (
    <div className="space-y-4">
      {memo?.rows[0] && (
        <blockquote className="rounded border-l-4 border-graphite bg-panel px-4 py-3 font-serif text-[15px] italic text-graphite">
          “{memo.rows[0].label}”
          <div className="mt-1 font-sans text-xs not-italic text-faint">Prior preparer’s summary memo (2024)</div>
        </blockquote>
      )}
      {open && <TheyVsUs section={open} findings={view.findings} />}
      {notes && <TheyVsUs section={notes} findings={view.findings} />}
      <Rest sections={s.rest(['memo', 'open-items', 'notes'])} />
    </div>
  );
}

function TheyVsUs({ section, findings }: { section: ViewSection; findings: ViewDto['findings'] }) {
  const drawer = useDrawer();
  return (
    <Box title={section.title}>
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-0 border-b border-rule text-xs font-semibold text-graphite">
        <span className="px-3 py-1.5">They said (2024 file)</span>
        <span className="border-l border-rule px-3 py-1.5">What this return does</span>
      </div>
      {section.rows.map((r) => {
        const flags = [...(r.flags ?? []), ...findings.filter((f) => r.nodeId && f.nodeIds?.includes(r.nodeId))];
        const what = String(r.cells.what?.value ?? '');
        return (
          <div key={r.id} className={clsx('grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] border-b border-ruleSoft last:border-0', rowTone(flags))}>
            <div className="cursor-pointer px-3 py-2 text-sm hover:bg-paper" onClick={() => r.nodeId && drawer.open(r.nodeId)}>
              <div className="font-serif">{r.label}</div>
            </div>
            <div className="border-l border-rule px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={statusTone(r.status)}>{r.status ?? '—'}</Pill>
                {r.cells.thisReturn && (
                  <span className="text-xs text-graphite">
                    line value <Num cell={r.cells.thisReturn} />
                  </span>
                )}
              </div>
              <div className="mt-1">{what || <span className="text-xs text-faint">Nothing recorded yet.</span>}</div>
              <div className="mt-1">
                <NodeChips ids={r.links} />
              </div>
              {flags.map((f, i) => (
                <FlagText key={i} flag={f} chips={false} className="mt-1" />
              ))}
            </div>
          </div>
        );
      })}
    </Box>
  );
}
