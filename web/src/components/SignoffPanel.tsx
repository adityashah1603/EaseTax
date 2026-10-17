// Sign-offs on a scope (an area or the whole return) at three levels. They reopen on
// their own when a signed value changes; the panel shows exactly what changed.
import type { CommandResult, SignoffDto, SignoffLevel } from '@easetax/shared';
import clsx from 'clsx';
import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api/client';
import { useSignoffs } from '../api/hooks';
import { fmtDateTime } from '../lib/format';
import { useDrawer } from '../state/drawer';
import { useSession } from '../state/session';
import { useCommand } from './actions';
import { ErrorBox } from './ui';

const LEVELS: SignoffLevel[] = ['preparer', 'reviewer', 'partner'];

function canSign(role: string | undefined, level: SignoffLevel) {
  if (level === 'preparer') return role === 'preparer';
  if (level === 'reviewer') return role === 'reviewer' || role === 'partner';
  return role === 'partner';
}

export function SignoffPanel({ scope, compact }: { scope: string; compact?: boolean }) {
  const all = useSignoffs();
  const { actor, nameOf } = useSession();
  const drawer = useDrawer();
  const run = useCommand();
  const [error, setError] = useState<{ level: SignoffLevel; e: unknown } | null>(null);
  const [busy, setBusy] = useState<SignoffLevel | null>(null);
  const mine = (all.data ?? []).filter((s) => s.scope === scope && s.status !== 'withdrawn');

  const latest = (level: SignoffLevel): SignoffDto | undefined =>
    mine.filter((s) => s.level === level).sort((a, b) => b.at.localeCompare(a.at))[0];

  const sign = async (level: SignoffLevel) => {
    setError(null);
    setBusy(level);
    try {
      await run(() => api<CommandResult>('/api/signoffs', { method: 'POST', body: { scope, level } }), { done: `Signed off as ${level}` });
    } catch (e) {
      setError({ level, e });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={clsx('rounded border border-rule bg-panel', compact ? 'text-xs' : 'text-sm')}>
      {LEVELS.map((level) => {
        const s = latest(level);
        const reopened = s?.status === 'reopened';
        return (
          <div key={level} className={clsx('border-b border-ruleSoft px-3 py-1.5 last:border-0', reopened && 'bg-pencil-soft')}>
            <div className="flex items-center gap-2">
              {s && !reopened ? <ShieldCheck size={14} className="text-ledger" /> : reopened ? <ShieldAlert size={14} className="text-pencil" /> : <span className="h-3.5 w-3.5 rounded-full border border-rule" />}
              <span className="w-[64px] font-semibold capitalize">{level}</span>
              <span className="min-w-0 flex-1 truncate">
                {!s && <span className="text-faint">Not signed</span>}
                {s && !reopened && (
                  <span>
                    {nameOf(s.by)} <span className="text-faint">{fmtDateTime(s.at)}</span>
                  </span>
                )}
                {reopened && (
                  <span className="font-semibold text-pencil-ink">
                    Reopened: {nameOf(s!.by)}'s sign-off no longer matches (event #{s!.reopenedBySeq}){s!.reopenedReason ? ` · ${s!.reopenedReason}` : ''}
                  </span>
                )}
              </span>
              {canSign(actor?.role, level) && (
                <button className={clsx(reopened ? 'btn-primary' : 'btn', 'py-0.5 text-xs')} disabled={busy === level} onClick={() => sign(level)}>
                  {s ? 'Sign again' : 'Sign off'}
                </button>
              )}
            </div>
            {reopened && s?.changedNodeIds && s.changedNodeIds.length > 0 && (
              <div className="ml-[86px] mt-0.5 flex flex-wrap gap-1">
                <span className="text-graphite">Changed:</span>
                {s.changedNodeIds.slice(0, 8).map((id) => (
                  <button key={id} className="text-blue-ink underline underline-offset-2" onClick={() => drawer.open(id)}>
                    {id.replace(/^line:[^:]+:/, '')}
                  </button>
                ))}
                {s.changedNodeIds.length > 8 && <span className="text-faint">+{s.changedNodeIds.length - 8} more</span>}
              </div>
            )}
            {error?.level === level && (
              <div className="mt-1.5">
                <ErrorBox error={error.e} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
