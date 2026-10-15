// The season as of a moment (FR-9, D-13). A view filter only: documents received by then,
// the engine version current then, and the scripted timeline up to then. Never writes.
import clsx from 'clsx';
import { ChevronLeft, ChevronRight, Radio } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useDocuments, useMe, useSummary } from '../../api/hooks';
import { versionAt } from '../../components/workflow/HeaderWidgets';
import { setReplayAt, useReplayAt } from '../../components/workflow/replayClock';
import { Panel } from '../../components/workflow/bits';
import { Empty, ErrorBox, Loading } from '../../components/ui';
import { fmtDate, fmtDateTime, fmtNum, humanize } from '../../lib/format';

export function Replay() {
  const at = useReplayAt();
  const me = useMe();
  const summary = useSummary();
  const docs = useDocuments();
  const timeline = me.data?.clock.timeline ?? [];
  const idx = at ? timeline.map((t) => t.at <= at).lastIndexOf(true) : -1;
  const past = at ? timeline.filter((t) => t.at <= at) : timeline;
  const versions = summary.data?.versions ?? [];
  const ver = at ? versionAt(versions, at) : versions.find((v) => v.version === summary.data?.currentVersion);
  const byMonth = new Map<string, number>();
  for (const d of docs.data ?? []) byMonth.set(d.receivedAt.slice(0, 7), (byMonth.get(d.receivedAt.slice(0, 7)) ?? 0) + 1);
  const go = (i: number) => setReplayAt(timeline[Math.max(0, Math.min(timeline.length - 1, i))]!.at);

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-5">
      <div className={clsx('mb-4 rounded border px-4 py-3', at ? 'border-amber bg-amber-soft' : 'border-rule bg-panel')}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-graphite">{at ? 'Replaying the season' : 'Live'}</div>
            <h1 className="font-serif text-2xl font-semibold">{at ? `As of ${fmtDate(at)}, ${new Date(at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : 'The file as it is now'}</h1>
            {at && idx >= 0 && <div className="text-sm text-amber-ink">Last event: {humanize(timeline[idx]!.event)}</div>}
          </div>
          <div className="flex items-center gap-1">
            <button className="btn" disabled={!timeline.length || idx <= 0} onClick={() => go(idx - 1)} aria-label="Previous moment">
              <ChevronLeft size={14} />
            </button>
            <button className="btn" disabled={!timeline.length || idx >= timeline.length - 1} onClick={() => go(idx + 1)} aria-label="Next moment">
              <ChevronRight size={14} />
            </button>
            {at && (
              <button className="btn" onClick={() => setReplayAt(null)}>
                <Radio size={14} /> Back to live
              </button>
            )}
          </div>
        </div>
        <input
          type="range"
          className="mt-3 w-full accent-[#9A6A10]"
          min={0}
          max={Math.max(0, timeline.length - 1)}
          value={idx < 0 ? Math.max(0, timeline.length - 1) : idx}
          onChange={(e) => go(Number(e.target.value))}
          aria-label="Replay moment"
          disabled={!timeline.length}
        />
        <p className="mt-1 text-2xs text-graphite">
          A view filter (D-13): documents are shown if received by then and the engine version is the latest computed by then. Nothing is written, and work done by people in the
          workpaper always shows in real time.
        </p>
      </div>

      <div className="grid gap-x-5 lg:grid-cols-2">
        <Panel title="Engine version current then" sub="Each version's computed-at time from the engine runs.">
          {summary.isLoading ? (
            <Loading />
          ) : !ver ? (
            <p className="text-sm text-graphite">No engine run yet: the first computation is on {fmtDate(versions[0]?.computedAt)}.</p>
          ) : (
            <div>
              <div className="flex items-baseline gap-2">
                <span className="font-serif text-3xl font-semibold">{ver.version}</span>
                <span className="text-xs text-graphite">computed {fmtDateTime(ver.computedAt)}</span>
                {ver.version !== summary.data?.currentVersion && <span className="text-xs text-amber-ink">(the workpaper now shows {summary.data?.currentVersion})</span>}
              </div>
              <p className="mt-1 text-xs text-graphite">{ver.trigger}</p>
              <div className="mt-2 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <div className="text-xs text-graphite">Federal total tax / balance due</div>
                  <div className="num font-semibold">
                    {fmtNum(ver.federal.total_tax)} / {fmtNum(ver.federal.balance_due)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-graphite">California total tax / balance due</div>
                  <div className="num font-semibold">
                    {fmtNum(ver.california.total_tax)} / {fmtNum(ver.california.balance_due)}
                  </div>
                </div>
              </div>
              <ol className="mt-3 flex gap-1 text-2xs">
                {versions.map((v) => (
                  <li key={v.version} className={clsx('rounded px-1.5 py-0.5', v.version === ver.version ? 'bg-ink text-white' : at && v.computedAt > at ? 'border border-dashed border-rule text-faint' : 'bg-ruleSoft text-graphite')}>
                    {v.version} · {fmtDate(v.computedAt)}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Panel>

        <Panel
          title="Documents on file then"
          sub={
            <>
              Received by this moment. The <Link to="/documents" className="text-blue-ink underline">documents board</Link> applies the same filter while the clock is on.
            </>
          }
        >
          <ErrorBox error={docs.error} />
          {docs.isLoading ? (
            <Loading />
          ) : (
            <>
              <div className="num font-serif text-3xl font-semibold">{docs.data?.length ?? 0}</div>
              <div className="mt-2 flex flex-wrap gap-1 text-2xs">
                {[...byMonth.entries()].sort().map(([m, n]) => (
                  <span key={m} className="num rounded bg-ruleSoft px-1.5 py-0.5 text-graphite">
                    {m}: {n}
                  </span>
                ))}
              </div>
              <ul className="mt-2 max-h-[180px] overflow-auto text-xs">
                {[...(docs.data ?? [])]
                  .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
                  .slice(0, 12)
                  .map((d) => (
                    <li key={d.id} className="flex gap-2 border-b border-ruleSoft py-0.5">
                      <span className="num w-[86px] shrink-0 text-faint">{fmtDate(d.receivedAt)}</span>
                      <Link to={`/documents/${d.id}`} className="min-w-0 truncate hover:underline">
                        {d.id} {d.title}
                      </Link>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </Panel>
      </div>

      <Panel title="Timeline up to then" sub="The packet's scripted events. Click one to move the clock there.">
        {past.length === 0 ? (
          <Empty>Nothing had happened yet.</Empty>
        ) : (
          <ol className="relative ml-2 border-l border-rule">
            {past.map((t) => (
              <li key={t.id} className="relative pl-4">
                <span className={clsx('absolute -left-[5px] top-2 h-2.5 w-2.5 rounded-full', t.at === at ? 'bg-amber' : 'bg-graphite')} />
                <button className="flex w-full items-baseline gap-3 rounded px-1 py-1 text-left hover:bg-ruleSoft" onClick={() => setReplayAt(t.at)}>
                  <span className="num w-[150px] shrink-0 text-xs text-graphite">
                    {fmtDate(t.at)} {new Date(t.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                  <span className={clsx('text-sm', t.at === at && 'font-semibold')}>{humanize(t.event)}</span>
                </button>
              </li>
            ))}
          </ol>
        )}
      </Panel>
    </div>
  );
}
