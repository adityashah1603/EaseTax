// Document index as a coverage board: every document either feeds the return or carries a
// reason it doesn't. Unused without a reason is red.
import type { DocumentDto } from '@easetax/shared';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useDocuments, useSummary } from '../api/hooks';
import { DispositionDialog, DISPOSITION_LABEL } from '../components/DispositionDialog';
import { Kbd, Loading } from '../components/ui';
import { useListNav } from '../lib/useListNav';
import { useSession } from '../state/session';

type Group = 'missing' | 'used' | 'reasoned';

function groupOf(d: DocumentDto): Group {
  if (!d.disposition || d.disposition.status === 'pending') return 'missing';
  return d.disposition.status === 'used' ? 'used' : 'reasoned';
}

const GROUPS: { id: Group; title: string; blurb: string }[] = [
  { id: 'missing', title: 'Needs a disposition', blurb: 'Feeds nothing and has no recorded reason. Decide each one.' },
  { id: 'used', title: 'Used in the return', blurb: 'At least one extracted value lands on a return line.' },
  { id: 'reasoned', title: 'Not used, with a reason', blurb: 'Superseded, duplicate, out of year, or outside scope.' },
];

export function Documents() {
  const docs = useDocuments();
  const summary = useSummary();
  const navigate = useNavigate();
  const { can } = useSession();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<DocumentDto | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const year = summary.data?.taxYear;

  const filtered = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (docs.data ?? []).filter((d) => !n || `${d.id} ${d.title} ${d.documentType} ${d.issuer}`.toLowerCase().includes(n));
  }, [docs.data, q]);
  const ordered = useMemo(() => GROUPS.flatMap((g) => filtered.filter((d) => groupOf(d) === g.id)), [filtered]);

  const [cursor, setCursor] = useListNav(ordered.length, {
    Enter: () => ordered[cursor] && navigate(`/documents/${ordered[cursor]!.id}`),
    d: () => ordered[cursor] && can('disposition') && setEditing(ordered[cursor]!),
  });
  useEffect(() => {
    (board.current?.querySelector(`[data-idx="${cursor}"]`) as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  const counts = (g: Group) => (docs.data ?? []).filter((d) => groupOf(d) === g).length;

  return (
    <div className="mx-auto max-w-[1240px] px-6 py-5" ref={board}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold">Documents</h1>
          <p className="text-sm text-graphite">
            {docs.data ? (
              <>
                {docs.data.length} received ·{' '}
                <span className={clsx(counts('missing') ? 'font-semibold text-pencil' : 'text-ledger')}>{counts('missing')} without a disposition</span> · {counts('used')} used ·{' '}
                {counts('reasoned')} set aside with a reason
              </>
            ) : (
              'Loading…'
            )}
          </p>
        </div>
        <input className="input max-w-[280px]" placeholder="Filter: W-2, Meridian, D31…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter documents" />
      </div>
      {!docs.data ? (
        <Loading what="documents" />
      ) : (
        GROUPS.map((g) => {
          const list = filtered.filter((d) => groupOf(d) === g.id);
          if (!list.length) return null;
          return (
            <section key={g.id} className="mb-6">
              <h2 className={clsx('text-sm font-semibold', g.id === 'missing' ? 'text-pencil' : 'text-graphite')}>
                {g.title} <span className="font-normal text-faint">{list.length}</span>
              </h2>
              <p className="mb-2 text-xs text-faint">{g.blurb}</p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {list.map((d) => {
                  const idx = ordered.indexOf(d);
                  return (
                    <DocTile
                      key={d.id}
                      d={d}
                      idx={idx}
                      active={idx === cursor}
                      year={year}
                      onOpen={() => (setCursor(idx), navigate(`/documents/${d.id}`))}
                      onEdit={can('disposition') ? () => setEditing(d) : undefined}
                    />
                  );
                })}
              </div>
            </section>
          );
        })
      )}
      <p className="text-xs text-faint">
        <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>Enter</Kbd> open · <Kbd>d</Kbd> set disposition
      </p>
      {editing && <DispositionDialog doc={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function DocTile({ d, idx, active, year, onOpen, onEdit }: { d: DocumentDto; idx: number; active: boolean; year?: number; onOpen: () => void; onEdit?: () => void }) {
  const g = groupOf(d);
  const outOfYear = year !== undefined && d.taxYear !== year;
  return (
    <div
      data-idx={idx}
      onClick={onOpen}
      className={clsx(
        'flex cursor-pointer flex-col rounded border bg-panel px-3 py-2 text-sm',
        g === 'missing' ? 'border-pencil border-l-4' : 'border-rule',
        active && 'ring-2 ring-blue',
        'hover:border-graphite',
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{d.id}</span>
        <span className="truncate text-xs text-graphite">{d.documentType}</span>
      </div>
      <div className="truncate text-xs" title={d.title}>
        {d.title}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1 text-2xs">
        {d.disposition ? (
          <span
            className={clsx('rounded px-1.5 font-semibold', d.disposition.status === 'used' ? 'bg-ledger-soft text-ledger-ink' : 'bg-ruleSoft text-graphite')}
            title={d.disposition.note ?? (d.disposition.derived ? 'Derived from the packet' : undefined)}
          >
            {DISPOSITION_LABEL[d.disposition.status]}
            {d.disposition.derived && ' (auto)'}
          </span>
        ) : (
          <span className="rounded bg-pencil px-1.5 font-semibold text-white">No disposition</span>
        )}
        <span className="num text-graphite">{d.linesFed} lines fed</span>
        {d.openIssues > 0 && <span className="rounded bg-pencil-soft px-1 font-semibold text-pencil-ink">{d.openIssues} issue(s)</span>}
        {d.markedCorrected && <span className="rounded bg-amber-soft px-1 font-semibold text-amber-ink">Corrected</span>}
        {d.extraction.status !== 'extracted' && (
          <span className="rounded bg-amber-soft px-1 text-amber-ink" title={d.extraction.reason ?? undefined}>
            {d.extraction.status.replace('_', ' ')}
          </span>
        )}
        {outOfYear && (
          <span className={clsx('rounded px-1', d.linesFed > 0 ? 'bg-pencil-soft font-semibold text-pencil-ink' : 'bg-ruleSoft text-graphite')} title={d.linesFed > 0 ? `A ${d.taxYear} form feeds ${year} lines` : undefined}>
            TY {d.taxYear}
          </span>
        )}
      </div>
      {d.disposition?.note && <div className="mt-1 line-clamp-2 text-2xs text-graphite">{d.disposition.note}</div>}
      {onEdit && (
        <button
          className="btn-ghost mt-1 self-start text-xs"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          {d.disposition ? 'Change disposition' : 'Set disposition'}
        </button>
      )}
    </div>
  );
}
