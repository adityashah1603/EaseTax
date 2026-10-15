// Sales detail (Form 8949): exceptions grouped by kind, broker summary vs detail, then
// box × term × broker groups that drill into their lots. 295 lots never render at once.
import type { ViewDto, ViewFlag, ViewRow } from '@easetax/shared';
import { useVirtualizer } from '@tanstack/react-virtual';
import clsx from 'clsx';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useMemo, useRef, useState, type CSSProperties } from 'react';
import { humanize } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { Box, Collapsible, FlagText, Num, Plain, Rest, SEV_RANK, SevIcon, Stat, Verdict, num, rowTone, sectionsOf, worst } from './kit';

const LOT_COLS = 'grid-cols-[18px_minmax(0,1fr)_100px_100px_90px_100px]';

export function Sales({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const meta = (view.meta ?? {}) as { lots?: number; exceptions?: number };
  const exceptions = s.get('exceptions');
  const groups = s.get('groups');
  const recon = s.get('summary-vs-detail');
  const lots = s.get('lots');
  const allLots = lots?.rows ?? [];
  const wash = allLots.filter((r) => r.flags?.some((f) => f.code === 'WASH_SALE')).length;
  const gainTotal = (groups?.totals ?? []).reduce((t, r) => t + (num(r.cells.gain) ?? 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Lots">{meta.lots ?? allLots.length}</Stat>
        <Stat label="Exceptions" tone={meta.exceptions ? 'warn' : 'ok'}>
          {meta.exceptions ?? exceptions?.rows.length ?? 0}
        </Stat>
        <Stat label="Wash-sale lots">{wash}</Stat>
        <Stat label="Net gain, all boxes (return lines)">
          <Plain value={gainTotal} />
        </Stat>
      </div>

      {exceptions && <ExceptionGroups rows={exceptions.rows} title={exceptions.title} />}

      {recon && (
        <Box title={recon.title} note="Each broker’s 1099 summary proceeds against the sum of the lots we hold for it.">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-rule text-xs text-graphite">
                <th className="px-3 py-1.5 text-left font-semibold">Statement</th>
                <th className="px-2 py-1.5 text-right font-semibold">1099 summary</th>
                <th className="px-2 py-1.5 text-right font-semibold">Sum of lots</th>
                <th className="px-2 py-1.5 text-right font-semibold">Lots</th>
                <th className="px-2 py-1.5 text-right font-semibold">Difference</th>
                <th className="px-3 py-1.5 text-left font-semibold">Check</th>
              </tr>
            </thead>
            <tbody>
              {recon.rows.map((r) => {
                const diff = num(r.cells.difference) ?? 0;
                const superseded = /superseded/i.test(r.sublabel ?? '');
                return (
                  <tr key={r.id} className={clsx('border-b border-ruleSoft align-top last:border-0', !superseded && rowTone(r.flags), superseded && 'text-faint')}>
                    <td className="px-3 py-1.5">
                      <RowLink r={r} />
                      <div className="text-xs text-faint">{r.sublabel}</div>
                      {r.flags?.map((f, i) => <FlagText key={i} flag={f} className="mt-0.5" />)}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Num cell={r.cells.summary} />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Num cell={r.cells.detail} />
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Num cell={r.cells.count} kind="number" />
                    </td>
                    <td className={clsx('px-2 py-1.5 text-right', diff && !superseded && 'font-semibold text-pencil-ink')}>
                      <Num cell={r.cells.difference} />
                    </td>
                    <td className="px-3 py-1.5">{superseded ? <span className="text-xs">superseded, not used</span> : <Verdict ok={Math.abs(diff) < 1}>{Math.abs(diff) < 1 ? 'agrees' : 'detail missing'}</Verdict>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Box>
      )}

      {groups && <GroupTable groups={groups.rows} totals={groups.totals ?? []} lots={allLots} />}

      {lots && <AllLots rows={allLots} title={lots.title} note={lots.note} />}

      <Rest sections={s.rest(['exceptions', 'groups', 'summary-vs-detail', 'lots'])} />
    </div>
  );
}

function RowLink({ r }: { r: ViewRow }) {
  const drawer = useDrawer();
  return r.nodeId ? (
    <button className="text-left hover:text-blue-ink hover:underline" onClick={() => drawer.open(r.nodeId!)}>
      {r.label}
    </button>
  ) : (
    <span>{r.label}</span>
  );
}

/** Exceptions bucketed by what is wrong; errors and warnings open, informational buckets folded. */
function ExceptionGroups({ rows, title }: { rows: ViewRow[]; title: string }) {
  const buckets = useMemo(() => {
    const m = new Map<string, { code: string; severity: ViewFlag['severity']; rows: ViewRow[] }>();
    for (const r of rows) {
      const f = [...(r.flags ?? [])].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0];
      const code = f?.code ?? 'OTHER';
      const b = m.get(code) ?? { code, severity: f?.severity ?? 'info', rows: [] };
      b.rows.push(r);
      m.set(code, b);
    }
    return [...m.values()].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.rows.length - a.rows.length);
  }, [rows]);
  return (
    <Box title={title} note="Bucketed by the check that raised them. Each lot opens its trace.">
      <div className="divide-y divide-rule">
        {buckets.map((b) => (
          <Collapsible
            key={b.code}
            defaultOpen={b.severity !== 'info' && b.rows.length <= 12}
            title={
              <span className="flex items-center gap-1.5">
                <SevIcon severity={b.severity} />
                <span className="text-ink">{humanize(b.code.toLowerCase())}</span>
                <span className="font-normal text-faint">{b.rows.length} lot(s)</span>
              </span>
            }
            right={<span className="num text-xs font-normal text-graphite">gain {fmtSum(b.rows)}</span>}
          >
            <LotHeader />
            {b.rows.map((r) => (
              <LotRow key={r.id} r={r} showFlag />
            ))}
          </Collapsible>
        ))}
      </div>
    </Box>
  );
}

const fmtSum = (rows: ViewRow[]) => {
  const t = rows.reduce((s, r) => s + (num(r.cells.gain) ?? 0), 0);
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(t);
};

function LotHeader() {
  return (
    <div className={clsx('grid items-center gap-2 border-y border-ruleSoft bg-paper px-3 py-1 text-2xs font-semibold text-graphite', LOT_COLS)}>
      <span />
      <span>Lot</span>
      <span className="text-right">Proceeds</span>
      <span className="text-right">Basis</span>
      <span className="text-right">Adjustment</span>
      <span className="text-right">Gain (loss)</span>
    </div>
  );
}

function LotRow({ r, showFlag, style }: { r: ViewRow; showFlag?: boolean; style?: CSSProperties }) {
  const drawer = useDrawer();
  const w = worst(r.flags);
  return (
    <div style={style} className={clsx('cursor-pointer border-b border-ruleSoft px-3 hover:bg-paper', rowTone(r.flags))} onClick={() => r.nodeId && drawer.open(r.nodeId)}>
      <div className={clsx('grid items-center gap-2 py-1 text-sm', LOT_COLS)}>
        <span title={r.flags?.map((f) => f.text).join('\n')}>{w && <SevIcon severity={w} size={12} />}</span>
        <span className="min-w-0 truncate" title={`${r.label} · ${r.sublabel ?? ''}`}>
          <span className="text-2xs text-faint">{r.id.replace(/^F8949\./, '')}</span> {r.label} <span className="text-xs text-faint">{(r.sublabel ?? '').split(' · ').slice(2).join(' · ')}</span>
        </span>
        <Num cell={r.cells.proceeds} className="text-right" />
        <Num cell={r.cells.basis} className="text-right" />
        <Num cell={r.cells.adjustment} className="text-right" />
        <Num cell={r.cells.gain} className="text-right" />
      </div>
      {showFlag && r.flags?.map((f, i) => <FlagText key={i} flag={f} className="mb-1 ml-[26px]" />)}
    </div>
  );
}

/** A virtualized lot list: smooth at 295 rows, and the same component inside a group. */
function LotList({ rows, height }: { rows: ViewRow[]; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => ref.current, estimateSize: () => 31, overscan: 10 });
  return (
    <>
      <LotHeader />
      <div ref={ref} className="overflow-auto" style={{ maxHeight: height }}>
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vi) => (
            <LotRow key={vi.key} r={rows[vi.index]!} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: vi.size, transform: `translateY(${vi.start}px)` }} />
          ))}
        </div>
      </div>
    </>
  );
}

function GroupTable({ groups, totals, lots }: { groups: ViewRow[]; totals: ViewRow[]; lots: ViewRow[] }) {
  const [open, setOpen] = useState<string | null>(null);
  const boxOf = (r: ViewRow) => r.id.split('|')[0]!;
  const totalByBox = new Map(totals.map((t) => [t.id.replace(/^box:/, ''), t]));
  const boxes = [...new Set(groups.map(boxOf))];
  const lotsFor = (g: ViewRow) => lots.filter((l) => (l.sublabel ?? '').startsWith(g.label));
  return (
    <Box title="By box, term and broker" note="One line per group; the box total is checked against the sum of its lots. Open a group for its lots.">
      <div className="grid grid-cols-[22px_minmax(0,1fr)_60px_110px_110px_100px_110px] gap-2 border-b border-rule px-3 py-1.5 text-xs font-semibold text-graphite">
        <span />
        <span>Group</span>
        <span className="text-right">Lots</span>
        <span className="text-right">Proceeds</span>
        <span className="text-right">Basis</span>
        <span className="text-right">Adjustment</span>
        <span className="text-right">Gain (loss)</span>
      </div>
      {boxes.map((box) => {
        const t = totalByBox.get(box);
        const lineGain = num(t?.cells.gain);
        const lotsGain = num(t?.cells.lotsGain);
        const agrees = lineGain !== undefined && lotsGain !== undefined && Math.abs(lineGain - lotsGain) < 1;
        return (
          <div key={box} className="border-b border-rule last:border-0">
            {groups
              .filter((g) => boxOf(g) === box)
              .map((g) => {
                const isOpen = open === g.id;
                const exc = /(\d+) exception/.exec(g.sublabel ?? '')?.[1];
                return (
                  <div key={g.id}>
                    <button
                      type="button"
                      className={clsx('grid w-full grid-cols-[22px_minmax(0,1fr)_60px_110px_110px_100px_110px] items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-paper', isOpen && 'bg-paper')}
                      onClick={() => setOpen(isOpen ? null : g.id)}
                      aria-expanded={isOpen}
                    >
                      <span className="text-graphite">{isOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
                      <span className="min-w-0 truncate">
                        {g.label}
                        {exc && Number(exc) > 0 && <span className="ml-2 rounded bg-amber-soft px-1 text-2xs font-semibold text-amber-ink">{exc} exception(s)</span>}
                      </span>
                      <Num cell={g.cells.count} kind="number" className="text-right" />
                      <Num cell={g.cells.proceeds} className="text-right" />
                      <Num cell={g.cells.basis} className="text-right" />
                      <Num cell={g.cells.adjustment} className="text-right" />
                      <Num cell={g.cells.gain} className="text-right" />
                    </button>
                    {isOpen && (
                      <div className="mx-3 mb-2 rounded border border-rule">
                        <LotList rows={lotsFor(g)} height={320} />
                      </div>
                    )}
                  </div>
                );
              })}
            {t && (
              <div className="grid grid-cols-[22px_minmax(0,1fr)_60px_110px_110px_100px_110px] items-center gap-2 bg-paper px-3 py-1 text-sm font-semibold">
                <span />
                <span className="flex items-center gap-3">
                  {t.label}
                  <span className="font-normal">
                    <Verdict ok={agrees} warn={!agrees}>
                      {agrees ? 'lots agree to the 8949 line' : `lots ${lotsGain ?? '—'} vs line ${lineGain ?? '—'}`}
                    </Verdict>
                  </span>
                </span>
                <Num cell={t.cells.count} kind="number" className="text-right" />
                <span />
                <span />
                <span />
                <Num cell={t.cells.gain} className="text-right" />
              </div>
            )}
          </div>
        );
      })}
    </Box>
  );
}

function AllLots({ rows, title, note }: { rows: ViewRow[]; title: string; note?: string }) {
  const [q, setQ] = useState('');
  const [onlyExc, setOnlyExc] = useState(false);
  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return rows.filter((r) => (!onlyExc || r.flags?.length) && (!n || `${r.id} ${r.label} ${r.sublabel}`.toLowerCase().includes(n)));
  }, [rows, q, onlyExc]);
  return (
    <Box
      title={title}
      note={note}
      right={
        <span className="flex items-center gap-3">
          <input className="input w-[240px]" placeholder="Search lots: ticker, broker, box, M14…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search lots" />
          <label className="flex items-center gap-1.5 text-xs">
            <input type="checkbox" checked={onlyExc} onChange={(e) => setOnlyExc(e.target.checked)} /> Exceptions only
          </label>
          <span className="num text-xs text-faint">{filtered.length} shown</span>
        </span>
      }
    >
      {filtered.length ? <LotList rows={filtered} height={420} /> : <div className="px-3 py-4 text-sm text-faint">No lots match.</div>}
    </Box>
  );
}
