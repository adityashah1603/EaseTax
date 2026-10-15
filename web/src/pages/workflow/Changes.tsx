// "What changed since I last looked" (FR-3.2): other people's events after my last
// mark-seen, grouped by the item they touched; each group opens the trace drawer.
import type { WorkEvent } from '@easetax/shared';
import { CheckCheck } from 'lucide-react';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useAdjustments, useIssues, useNotes, useQuestions } from '../../api/hooks';
import { useChangesSinceSeen } from '../../api/workflowHooks';
import { describeEvent, eventNodes, useAction } from '../../components/workflow/bits';
import { Empty, ErrorBox, Loading } from '../../components/ui';
import { fmtDateTime, humanize, NODE_KIND_LABEL } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { useSession } from '../../state/session';

interface Group {
  key: string;
  nodeId?: string;
  route?: string;
  title: string;
  events: WorkEvent[];
}

export function Changes() {
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
    <div className="mx-auto max-w-[960px] px-6 py-5">
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
          onClick={() => act.run('seen', () => api('/api/changes/mark-seen', { method: 'POST' }), 'Marked all as seen')}
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
    </div>
  );
}
