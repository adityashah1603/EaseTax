// Records index: every generated view with what it is for and what it currently finds.
import type { ViewDto, ViewListItem } from '@easetax/shared';
import clsx from 'clsx';
import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAllViews, useViewList } from '../../api/recordsHooks';
import { RECORD_GROUPS, recordFor } from '../../components/records/registry';
import { SEV_RANK, SevIcon } from '../../components/records/kit';
import { ErrorBox, Loading, Tick } from '../../components/ui';
import { useListNav } from '../../lib/useListNav';

export function RecordsIndex() {
  const list = useViewList();
  const items = useMemo(() => list.data ?? [], [list.data]);
  const views = useAllViews(items.map((v) => v.id));
  const byId = new Map(items.map((v, i) => [v.id, views[i]]));
  const grouped = RECORD_GROUPS.map((g) => ({ g, items: items.filter((v) => recordFor(v.id).group === g) })).filter((x) => x.items.length);
  const flat = grouped.flatMap((x) => x.items);
  const navigate = useNavigate();
  const ref = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useListNav(flat.length, { Enter: () => flat[cursor] && navigate(`/records/${flat[cursor]!.id}`) });
  useEffect(() => {
    (ref.current?.querySelector(`[data-idx="${cursor}"]`) as HTMLElement | null)?.focus({ preventScroll: false });
  }, [cursor]);

  const totals = useMemo(() => {
    let e = 0;
    let w = 0;
    for (const q of views) for (const f of q.data?.findings ?? []) f.severity === 'error' ? e++ : f.severity === 'warning' && w++;
    return { e, w, loaded: views.filter((q) => q.data).length };
  }, [views]);

  return (
    <div className="mx-auto max-w-[1180px] px-6 py-5">
      <h1 className="mb-1 font-serif text-2xl font-semibold">Records</h1>
      <p className="mb-4 max-w-[760px] text-sm text-graphite">
        The schedules a CPA expects, generated from the same graph as the return — never kept separately. Each one opens on its exceptions; every number opens its trace.
        {totals.loaded === items.length && items.length > 0 && (
          <>
            {' '}
            Across all records: <span className="font-semibold text-pencil-ink">{totals.e} errors</span>, <span className="font-semibold text-amber-ink">{totals.w} warnings</span>.
          </>
        )}
      </p>
      <ErrorBox error={list.error} />
      {list.isLoading && <Loading what="records" />}
      <div ref={ref} className="space-y-5">
        {grouped.map(({ g, items: its }) => (
          <section key={g}>
            <h2 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-graphite">{g}</h2>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              {its.map((v) => {
                const idx = flat.indexOf(v);
                return <RecordCard key={v.id} item={v} view={byId.get(v.id)?.data} loading={!!byId.get(v.id)?.isLoading} idx={idx} active={idx === cursor} onOpen={() => (setCursor(idx), navigate(`/records/${v.id}`))} />;
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function RecordCard({ item, view, loading, idx, active, onOpen }: { item: ViewListItem; view?: ViewDto; loading: boolean; idx: number; active: boolean; onOpen: () => void }) {
  const meta = recordFor(item.id);
  const f = view?.findings ?? [];
  const errors = f.filter((x) => x.severity === 'error').length;
  const warnings = f.filter((x) => x.severity === 'warning').length;
  const infos = f.filter((x) => x.severity === 'info').length;
  const top = [...f].sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity])[0];
  const adjusted = useMemo(() => {
    let n = 0;
    for (const s of view?.sections ?? []) for (const r of [...s.rows, ...(s.totals ?? [])]) for (const c of Object.values(r.cells)) if (c?.adjusted) n++;
    return n;
  }, [view]);
  return (
    <button
      data-idx={idx}
      onClick={onOpen}
      className={clsx(
        'group flex w-full items-start gap-3 rounded border bg-panel px-3 py-2.5 text-left hover:border-graphite',
        active ? 'border-blue ring-1 ring-blue' : 'border-rule',
        errors ? 'border-l-4 border-l-pencil' : warnings ? 'border-l-4 border-l-amber' : view ? 'border-l-4 border-l-ledger' : '',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold">{item.title}</span>
          <span className="text-2xs text-faint">{item.description}</span>
        </div>
        <div className="mt-0.5 text-sm text-graphite">{meta.purpose || item.description}</div>
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
          {loading && <span className="text-faint">checking…</span>}
          {view && !f.length && (
            <span className="inline-flex items-center gap-1 text-ledger-ink">
              <Tick size={12} /> no exceptions
            </span>
          )}
          {errors > 0 && <span className="rounded bg-pencil-soft px-1.5 font-semibold text-pencil-ink">{errors} error{errors > 1 ? 's' : ''}</span>}
          {warnings > 0 && <span className="rounded bg-amber-soft px-1.5 font-semibold text-amber-ink">{warnings} warning{warnings > 1 ? 's' : ''}</span>}
          {infos > 0 && <span className="rounded bg-ruleSoft px-1.5 text-graphite">{infos} info</span>}
          {adjusted > 0 && <span className="rounded bg-blue-soft px-1.5 font-semibold text-blue-ink">{adjusted} adjusted</span>}
        </div>
        {top && (
          <div className="mt-1 flex items-start gap-1.5 text-xs text-graphite">
            <span className="mt-[1px]">
              <SevIcon severity={top.severity} size={11} />
            </span>
            <span className="line-clamp-2">{top.text}</span>
          </div>
        )}
      </div>
      <ChevronRight size={16} className="mt-1 shrink-0 text-faint group-hover:text-ink" />
    </button>
  );
}
