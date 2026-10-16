// "What changed since I last looked" (FR-3.2): other people's events after my last
// mark-seen, grouped by the item they touched; each group opens the trace drawer.
// "My actions" (D-65): my own actions, newest first, each undoable after the toast is gone.
import type { WorkEvent } from '@easetax/shared';
import clsx from 'clsx';
import { CheckCheck, Undo2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { useAdjustments, useInvalidateAll, useIssues, useMyActions, useNotes, useQuestions } from '../../api/hooks';
import { useChangesSinceSeen } from '../../api/workflowHooks';
import { describeEvent, eventNodes, useAction } from '../../components/workflow/bits';
import { Empty, ErrorBox, Loading } from '../../components/ui';
import { fmtDateTime, humanize, NODE_KIND_LABEL } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { useSession } from '../../state/session';
import { useToast } from '../../state/toast';

interface Group {
  key: string;
  nodeId?: string;
  route?: string;
  title: string;
  events: WorkEvent[];
}

export function Changes() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'mine' ? 'mine' : 'others';
  return (
    <div className="mx-auto max-w-[960px] px-6 py-5">
      <div className="mb-4 flex gap-1 border-b border-rule" role="tablist">
        {([['others', 'Since you last looked'], ['mine', 'My actions']] as const).map(([t, label]) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={clsx('-mb-px border-b-2 px-3 py-1.5 text-sm', tab === t ? 'border-ink font-semibold' : 'border-transparent text-graphite hover:text-ink')}
            onClick={() => setParams(t === 'mine' ? { tab: 'mine' } : {}, { replace: true })}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'mine' ? <MyActions /> : <SinceLastSeen />}
    </div>
  );
}

/** D-65: my own actions; Undo works at any time, not only while the toast shows. */
function MyActions() {
  const mine = useMyActions();
  const issues = useIssues();
  const { can } = useSession();
  const drawer = useDrawer();
  const invalidate = useInvalidateAll();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const rows = mine.data ?? [];
  const keyOf = (t: object) => JSON.stringify(t);
  return (
    <>
      <h1 className="font-serif text-2xl font-semibold">My actions</h1>
      <p className="mb-4 text-sm text-graphite">
        Everything you did, newest first. Undo takes an action back at any time and is itself kept in the history. Only your own actions are listed; ask the
        person who did something else to undo it, or reopen the issue.
      </p>
      <ErrorBox error={mine.error} />
      {mine.isLoading ? (
        <Loading what="your actions" />
      ) : rows.length === 0 ? (
        <Empty>You haven't done anything on this return yet.</Empty>
      ) : (
        <ul className="overflow-hidden rounded border border-rule bg-panel">
          {rows.map((r) => {
            const e = r.events[0]!;
            const k = keyOf(r.target);
            const issueId = (e.payload as { issueId?: string }).issueId;
            const nodes = issueId ? issues.data?.find((i) => i.id === issueId)?.nodeIds ?? [] : eventNodes(e);
            const node = nodes.find((n) => n.startsWith('line:')) ?? nodes.find((n) => !n.startsWith('diag:'));
            return (
              <li key={k} className={clsx('flex items-start gap-3 border-b border-ruleSoft px-3 py-2 last:border-0', r.undone && 'opacity-60')}>
                <span className="num w-[110px] shrink-0 pt-0.5 text-xs text-faint">{fmtDateTime(e.at)}</span>
                <div className="min-w-0 flex-1 text-sm">
                  <span className={clsx(r.undone && 'line-through')}>{describeEvent(e)}</span>
                  {r.events.length > 1 && <span className="text-graphite"> ({r.events.length} items at once)</span>}
                  {r.undone && <span className="ml-2 rounded bg-ruleSoft px-1.5 text-2xs font-semibold text-graphite">undone</span>}
                  {e.reason && <span className="block text-xs text-graphite">“{e.reason}”</span>}
                  {(e.payload as { resolution?: string }).resolution && <span className="block text-xs text-graphite">“{(e.payload as { resolution?: string }).resolution}”</span>}
                  {node && (
                    <button className="block font-mono text-xs text-blue-ink underline decoration-dotted underline-offset-2" onClick={() => drawer.open(node)}>
                      {node}
                    </button>
                  )}
                  {!r.undone && !r.undoable && r.whyNot && <span className="block text-xs text-faint">Can't be undone: {r.whyNot}</span>}
                </div>
                {!r.undone && r.undoable && can('undo') && (
                  confirming === k ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs">
                      Undo this?
                      <button
                        className="btn-primary text-xs"
                        disabled={busy === k}
                        onClick={async () => {
                          setBusy(k);
                          try {
                            await api('/api/undo', { method: 'POST', body: r.target });
                            toast.push({ tone: 'info', text: 'Undone. The undo is recorded in the history.' });
                            invalidate();
                          } catch (x) {
                            toast.error(x, 'Undo failed');
                          } finally {
                            setBusy(null);
                            setConfirming(null);
                          }
                        }}
                      >
                        Yes, undo
                      </button>
                      <button className="btn-ghost text-xs" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </span>
                  ) : (
                    <button className="btn-ghost shrink-0 text-xs" onClick={() => setConfirming(k)}>
                      <Undo2 size={13} /> Undo
                    </button>
                  )
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}

function SinceLastSeen() {
  const changes = useChangesSinceSeen();
  const issues = useIssues();
  const notes = useNotes();
  const questions = useQuestions();
  const adjustments = useAdjustments();
  const { nameOf } = useSession();
  const drawer = useDrawer();
  const navigate = useNavigate();
  const act = useAction();
  const events = changes.data?.events ?? [];

  const groups = useMemo<Group[]>(() => {
    // Events that name an issue, note, question or adjustment point at that item's nodes.
    const via = (e: WorkEvent): string[] => {
      const p = e.payload as Record<string, unknown>;
      if (typeof p.issueId === 'string') return issues.data?.find((i) => i.id === p.issueId)?.nodeIds ?? [];
      if (typeof p.noteId === 'string') return notes.data?.find((n) => n.id === p.noteId)?.nodeIds ?? [];
      if (typeof p.questionId === 'string') return questions.data?.find((q) => q.id === p.questionId)?.nodeIds ?? [];
      if (typeof p.adjustmentId === 'string') {
        const a = adjustments.data?.find((x) => x.id === p.adjustmentId);
        return a ? [a.nodeId] : [];
      }
      return [];
    };
    const best = (ids: string[]) => ids.find((i) => i.startsWith('line:')) ?? ids.find((i) => !i.startsWith('diag:')) ?? ids[0];
    const m = new Map<string, Group>();
    for (const e of events) {
      const node = best([...eventNodes(e), ...via(e)]);
      let g: Omit<Group, 'events'>;
      if (node) g = { key: node, nodeId: node, title: node };
      else if (e.type.startsWith('signoff.')) g = { key: 'signoffs', route: '/signoffs', title: 'Sign-offs' };
      else if (e.type === 'filing.step') g = { key: 'filing', route: '/filing', title: 'Filing' };
      else if (e.type === 'firm.standards_updated' || e.type === 'time.logged' || e.type === 'assignment.created' || e.type === 'assignment.completed')
        g = { key: 'firm', route: '/firm', title: 'Firm and assignments' };
      else g = { key: 'return', title: 'Return-wide' };
      const cur = m.get(g.key) ?? { ...g, events: [] };
      cur.events.push(e);
      m.set(g.key, cur);
    }
    return [...m.values()].sort((a, b) => b.events.at(-1)!.seq - a.events.at(-1)!.seq);
  }, [events, issues.data, notes.data, questions.data, adjustments.data]);

  const people = [...new Set(events.map((e) => e.actor))];

  return (
    <>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold">Since you last looked</h1>
          <p className="text-sm text-graphite">
            {changes.isLoading
              ? 'Checking…'
              : events.length
                ? `${events.length} change(s) by ${people.map(nameOf).join(', ')} on ${groups.length} item(s), after event #${changes.data?.since ?? 0}. Your own work is not listed.`
                : `Nothing new from others since event #${changes.data?.since ?? 0}.`}
          </p>
        </div>
        <button
          className="btn-primary"
          disabled={!events.length || act.busy === 'seen'}
          onClick={() => act.run('seen', () => api('/api/changes/mark-seen', { method: 'POST', body: { seq: Math.max(...events.map((e) => e.seq)) } }), 'Marked all as seen')}
        >
          <CheckCheck size={14} /> Mark all seen
        </button>
      </div>
      <ErrorBox error={changes.error ?? act.error} />
      {changes.isLoading ? (
        <Loading what="changes" />
      ) : groups.length === 0 ? (
        <Empty>You're up to date. New work by others appears here and on the bell in the top bar.</Empty>
      ) : (
        <ul className="space-y-2">
          {groups.map((g) => {
            const kind = g.nodeId ? NODE_KIND_LABEL[g.nodeId.split(':')[0]!] ?? humanize(g.nodeId.split(':')[0]!) : undefined;
            return (
              <li key={g.key} className="rounded border border-rule bg-panel">
                <button
                  className="flex w-full items-baseline gap-2 border-b border-ruleSoft px-3 py-1.5 text-left hover:bg-paper"
                  onClick={() => (g.nodeId ? drawer.open(g.nodeId) : g.route ? navigate(g.route) : undefined)}
                  title={g.nodeId ? 'Open the trace' : undefined}
                >
                  {kind && <span className="text-2xs font-semibold text-graphite">{kind}</span>}
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-blue-ink underline decoration-dotted underline-offset-2">{g.title}</span>
                  <span className="text-2xs text-faint">{g.events.length} change(s)</span>
                </button>
                <ol className="px-3 py-1.5">
                  {g.events.map((e) => (
                    <li key={e.id} className="flex gap-2 py-0.5 text-sm">
                      <span className="num w-[110px] shrink-0 text-xs text-faint">{fmtDateTime(e.at)}</span>
                      <span className="min-w-0">
                        <span className="font-medium">{nameOf(e.actor)}</span> <span className="text-graphite">{describeEvent(e)}</span>
                        {e.reason && <span className="block text-xs text-graphite">“{e.reason}”</span>}
                      </span>
                      <span className="ml-auto text-2xs text-faint">#{e.seq}</span>
                    </li>
                  ))}
                </ol>
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
