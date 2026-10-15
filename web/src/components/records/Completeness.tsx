// Completeness: every document's disposition as a coverage board, the review areas
// considered, and filings that sit outside the return.
import type { ViewDto, ViewRow } from '@easetax/shared';
import clsx from 'clsx';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDrawer } from '../../state/drawer';
import { Box, FlagText, NodeChips, Pill, Rest, Verdict, sectionsOf, type Tone } from './kit';

const dispTone = (d: string): { tile: string; tone: Tone; label: string } => {
  if (d === 'none' || !d) return { tile: 'border-pencil bg-pencil-soft text-pencil-ink', tone: 'bad', label: 'no disposition' };
  if (/superseded|duplicate|out.of.year|not.used|unused/i.test(d)) return { tile: 'border-rule bg-ruleSoft text-graphite', tone: 'info', label: d };
  if (/used/i.test(d)) return { tile: 'border-ledger/50 bg-ledger-soft text-ledger-ink', tone: 'ok', label: d };
  return { tile: 'border-blue/50 bg-blue-soft text-blue-ink', tone: 'adj', label: d };
};

const dispOf = (r: ViewRow) => String(r.cells.disposition?.value ?? r.status ?? 'none') || 'none';

export function Completeness({ view }: { view: ViewDto }) {
  const s = sectionsOf(view);
  const docs = s.get('documents');
  const areas = s.get('areas');
  const outside = s.get('outside-filings');
  return (
    <div className="space-y-4">
      {docs && <CoverageBoard rows={docs.rows} title={docs.title} />}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {areas && (
          <Box title={areas.title} note="An area is complete when it is marked considered and its sign-offs are current.">
            <ul className="divide-y divide-ruleSoft text-sm">
              {areas.rows.map((r) => {
                const considered = !/not yet/i.test(r.status ?? '') && !!r.cells.considered?.value;
                return (
                  <li key={r.id} className="flex items-start gap-3 px-3 py-1.5">
                    <span className="mt-0.5">
                      <Verdict ok={considered} warn={!considered}>
                        {''}
                      </Verdict>
                    </span>
                    <span className="min-w-0 flex-1">
                      <Link className="hover:text-blue-ink hover:underline" to={`/areas/${r.id}`}>
                        {r.label}
                      </Link>
                      <div className="text-xs text-faint">{r.sublabel}</div>
                    </span>
                    <span className="text-right text-xs text-graphite">
                      <div>{considered ? String(r.cells.considered?.value) : r.status}</div>
                      <div className="text-faint">{String(r.cells.signoffs?.value || 'no valid sign-offs')}</div>
                    </span>
                  </li>
                );
              })}
            </ul>
          </Box>
        )}
        {outside && (
          <Box title={outside.title} note="Filings the return implies but does not contain. Each needs a recorded decision.">
            <ul className="divide-y divide-ruleSoft text-sm">
              {outside.rows.map((r) => (
                <OutsideRow key={r.id} r={r} />
              ))}
            </ul>
          </Box>
        )}
      </div>
      <Rest sections={s.rest(['documents', 'areas', 'outside-filings'])} />
    </div>
  );
}

function OutsideRow({ r }: { r: ViewRow }) {
  const drawer = useDrawer();
  const st = String(r.cells.status?.value ?? r.status ?? '');
  const decision = String(r.cells.decision?.value ?? '');
  return (
    <li className={clsx('px-3 py-2', st === 'open' && 'bg-amber-soft/30')}>
      <div className="flex items-start gap-2">
        <button className="min-w-0 flex-1 text-left font-medium hover:text-blue-ink hover:underline" onClick={() => r.nodeId && drawer.open(r.nodeId)}>
          {r.label}
        </button>
        <Pill tone={st === 'open' ? 'warn' : st === 'outside scope' ? 'info' : 'ok'}>{st}</Pill>
      </div>
      <div className="mt-0.5 text-xs text-graphite">{r.sublabel}</div>
      {decision && <div className="mt-0.5 text-xs text-ledger-ink">Decision: {decision}</div>}
      <div className="mt-1">
        <NodeChips ids={r.links} />
      </div>
    </li>
  );
}

function CoverageBoard({ rows, title }: { rows: ViewRow[]; title: string }) {
  const drawer = useDrawer();
  const [filter, setFilter] = useState<string>('all');
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(dispOf(r), (counts.get(dispOf(r)) ?? 0) + 1);
  const shown = rows.filter((r) => filter === 'all' || dispOf(r) === filter);
  const order = [...counts.entries()].sort((a, b) => (a[0] === 'none' ? -1 : b[0] === 'none' ? 1 : b[1] - a[1]));
  return (
    <Box title={`Document coverage (${rows.length})`} note={title !== `Documents (${rows.length})` ? title : 'Every document either feeds the return or has a stated reason not to. Red has neither.'}>
      <div className="p-3">
        <div className="flex h-3 overflow-hidden rounded-sm" aria-hidden>
          {order.map(([d, n]) => (
            <span key={d} className={clsx('border-r border-panel', dispTone(d).tile)} style={{ width: `${(n / rows.length) * 100}%` }} />
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5" role="tablist" aria-label="Filter by disposition">
          <button role="tab" aria-selected={filter === 'all'} className={clsx('rounded border px-2 py-0.5 text-xs', filter === 'all' ? 'border-ink bg-ink text-white' : 'border-rule')} onClick={() => setFilter('all')}>
            All {rows.length}
          </button>
          {order.map(([d, n]) => (
            <button key={d} role="tab" aria-selected={filter === d} className={clsx('rounded border px-2 py-0.5 text-xs', filter === d ? 'border-ink bg-ink text-white' : dispTone(d).tile)} onClick={() => setFilter(d)}>
              {dispTone(d).label} {n}
            </button>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
          {shown.map((r) => {
            const d = dispOf(r);
            const t = dispTone(d);
            const fed = Number(r.cells.linesFed?.value ?? 0);
            return (
              <button
                key={r.id}
                className={clsx('min-w-0 rounded border px-2 py-1 text-left hover:shadow', t.tile)}
                onClick={() => r.nodeId && drawer.open(r.nodeId)}
                title={`${r.label}\n${r.sublabel ?? ''}\n${t.label}${r.cells.note?.value ? ` — ${r.cells.note.value}` : ''}`}
              >
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-xs font-semibold">{r.id}</span>
                  <span className="text-2xs">{fed ? `${fed} line${fed > 1 ? 's' : ''}` : t.label}</span>
                </div>
                <div className="truncate text-2xs text-ink/80">{r.label}</div>
              </button>
            );
          })}
        </div>
        {filter === 'none' && shown.length > 0 && (
          <div className="mt-3 space-y-0.5">
            {shown.flatMap((r) => r.flags ?? []).length > 0 && <FlagText flag={{ code: 'NO_DISPOSITION', severity: 'warning', text: `${shown.length} document(s) neither feed a line nor carry a reason. Open one and record its disposition in Documents.` }} />}
          </div>
        )}
      </div>
    </Box>
  );
}
