// Top-bar widgets: "since I last looked" count and the replay clock (FR-3.2, FR-9).
import clsx from 'clsx';
import { Bell, Clock, Radio } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMe, useSummary } from '../../api/hooks';
import { useChangesSinceSeen } from '../../api/workflowHooks';
import { fmtDate, humanize } from '../../lib/format';
import { setReplayAt, useReplayAt } from './replayClock';

export function ChangesBadge() {
  const changes = useChangesSinceSeen();
  const navigate = useNavigate();
  const n = changes.data?.events.length ?? 0;
  return (
    <button
      className="relative grid h-8 w-8 place-items-center rounded hover:bg-ruleSoft"
      onClick={() => navigate('/changes')}
      title={n ? `${n} change(s) by others since you last looked` : 'Nothing new since you last looked'}
      aria-label={`Changes since I last looked: ${n}`}
    >
      <Bell size={16} className={n ? 'text-ink' : 'text-faint'} />
      {n > 0 && <span className="num absolute -right-0.5 -top-0.5 min-w-[17px] rounded-full bg-pencil px-1 text-center text-2xs font-semibold leading-[17px] text-white">{n > 99 ? '99+' : n}</span>}
    </button>
  );
}

/** Which engine version was current at a moment: the latest computed at or before it (D-13). */
export function versionAt<V extends { version: string; computedAt: string }>(versions: V[], at: string): V | undefined {
  return versions.filter((v) => v.computedAt <= at).at(-1);
}

export function ReplayClock() {
  const at = useReplayAt();
  const me = useMe();
  const summary = useSummary();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timeline = me.data?.clock.timeline ?? [];
  const ver = at && summary.data ? versionAt(summary.data.versions, at) : undefined;

  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, []);

  return (
    <div className="relative" ref={ref}>
      <button
        className={clsx(
          'flex items-center gap-1.5 rounded border px-2 py-1 text-xs',
          at ? 'border-amber bg-amber text-white shadow-[0_0_0_3px_rgba(154,106,16,0.18)]' : 'border-rule text-graphite hover:border-graphite',
        )}
        onClick={() => setOpen(!open)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={at ? 'Replay clock is on: documents and engine version are shown as of this moment' : 'Replay the season: show the file as of a moment in the timeline'}
      >
        {at ? <Clock size={14} /> : <Radio size={14} />}
        {at ? (
          <span className="font-semibold">
            As of {fmtDate(at)}
            {ver && <span className="font-normal opacity-90"> · engine {ver.version}</span>}
          </span>
        ) : (
          <span>Live</span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Replay clock" className="absolute right-0 top-full z-50 mt-1 w-[340px] rounded border border-rule bg-panel shadow-xl">
          <div className="border-b border-ruleSoft px-3 py-2 text-2xs text-graphite">
            Pick a moment in the packet's timeline. Documents received after it are hidden and the engine version current then is named. It is a view filter only: nothing is written, and
            work done by people still shows as it happens.
          </div>
          <ul className="max-h-[50vh] overflow-auto py-1">
            <li>
              <button
                className={clsx('flex w-full items-center gap-2 px-3 py-1 text-left text-sm hover:bg-ruleSoft', !at && 'bg-blue-soft font-semibold')}
                onClick={() => {
                  setReplayAt(null);
                  setOpen(false);
                }}
              >
                <Radio size={13} /> Live (now)
              </button>
            </li>
            {timeline.map((t) => (
              <li key={t.id}>
                <button
                  className={clsx('flex w-full items-baseline gap-2 px-3 py-1 text-left text-sm hover:bg-ruleSoft', at === t.at && 'bg-amber-soft font-semibold')}
                  onClick={() => {
                    setReplayAt(t.at);
                    setOpen(false);
                  }}
                >
                  <span className="num w-[92px] shrink-0 text-xs text-graphite">{fmtDate(t.at)}</span>
                  <span className="min-w-0 flex-1 truncate">{humanize(t.event)}</span>
                </button>
              </li>
            ))}
          </ul>
          <div className="flex justify-end border-t border-ruleSoft px-3 py-1.5">
            <button
              className="btn-ghost text-xs"
              onClick={() => {
                setOpen(false);
                navigate('/replay');
              }}
            >
              Open the season view
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
