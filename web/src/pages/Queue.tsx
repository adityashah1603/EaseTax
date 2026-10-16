// Home: "What needs me". One ranked queue of everything open, so a day-one hire can
// simply work down it and a partner sees approvals first.
import type { CommandResult, IssueDto } from '@easetax/shared';
import clsx from 'clsx';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { useAreaIndex, useAreas, useDocuments, useIssues, useNotes, useAdjustments, useQuestions, useSignoffs, useSummary } from '../api/hooks';
import { ReasonDialog, useCommand } from '../components/actions';
import { ClosureLine, IssueClosureButtons } from '../components/trace/sections';
import { Empty, Kbd, Loading, SeverityDot, SourceChip } from '../components/ui';
import { fmtEffect, fmtValue, humanize } from '../lib/format';
import { useListNav } from '../lib/useListNav';
import { useDrawer } from '../state/drawer';
import { useSession } from '../state/session';

type Kind = 'issue' | 'note' | 'question' | 'adjustment' | 'signoff' | 'document';

interface Item {
  key: string;
  kind: Kind;
  rank: number;
  severity: IssueDto['severity'] | 'blocking';
  title: string;
  sub?: string;
  area?: string;
  nodeId?: string;
  issue?: IssueDto;
  go?: () => void;
  right?: string;
}

const KIND_LABEL: Record<Kind, string> = {
  issue: 'Issue',
  note: 'Review note',
  question: 'Question',
  adjustment: 'Approval',
  signoff: 'Sign-off reopened',
  document: 'Document',
};

/** Best node to open for a set of ids: a return line, else a source value, else anything. */
function primaryNode(ids: string[]) {
  return ids.find((i) => i.startsWith('line:')) ?? ids.find((i) => i.startsWith('ev:')) ?? ids.find((i) => !i.startsWith('diag:')) ?? ids[0];
}

export function Queue() {
  const { actor, actorId, nameOf, can } = useSession();
  const issues = useIssues();
  const notes = useNotes();
  const questions = useQuestions();
  const signoffs = useSignoffs();
  const docs = useDocuments();
  const areas = useAreas();
  const summary = useSummary();
  const proposed = useAdjustments('proposed');
  const pending = proposed.data ?? [];
  const { areaOf } = useAreaIndex();
  const drawer = useDrawer();
  const navigate = useNavigate();
  const [area, setArea] = useState<string>('all');
  const [kinds, setKinds] = useState<Set<Kind>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<null | 'resolved' | 'accepted'>(null);
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const run = useCommand();
  const listRef = useRef<HTMLUListElement>(null);

  const isPartner = actor?.role === 'partner';
  const areaTitle = (id?: string) => areas.data?.find((a) => a.id === id)?.title;

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const n of notes.data ?? [])
      if (n.status === 'open')
        out.push({
          key: `note:${n.id}`,
          kind: 'note',
          rank: n.blocking ? 0 : 5,
          severity: n.blocking ? 'blocking' : 'warning',
          title: n.thread[0]?.text ?? '',
          sub: `${n.blocking ? 'Blocking · ' : ''}${nameOf(n.by)}`,
          area: areaOf(n.nodeIds),
          nodeId: primaryNode(n.nodeIds),
        });
    for (const s of signoffs.data ?? [])
      if (s.status === 'reopened')
        out.push({
          key: `so:${s.id}`,
          kind: 'signoff',
          rank: 1,
          severity: 'error',
          title: `${humanize(s.level)} sign-off on ${s.scope === 'return' ? 'the whole return' : areaTitle(s.scope.slice(5)) ?? s.scope} reopened`,
          sub: `Signed by ${nameOf(s.by)}; ${s.changedNodeIds?.length ?? 0} value(s) changed after (event #${s.reopenedBySeq})`,
          area: s.scope.startsWith('area:') ? s.scope.slice(5) : undefined,
          go: () => navigate('/signoffs'),
        });
    for (const a of pending)
      out.push({
        key: `adj:${a.id}`,
        kind: 'adjustment',
        rank: isPartner ? 0.5 : 4,
        severity: 'warning',
        title: `Adjustment awaiting partner: ${fmtValue(a.originalValue)} to ${fmtValue(a.newValue)}`,
        sub: `${nameOf(a.by)}: ${a.reason}`,
        right: fmtEffect(a.effect),
        area: areaOf([a.nodeId]),
        nodeId: a.nodeId,
      });
    for (const i of issues.data ?? [])
      if (i.status === 'open')
        out.push({
          key: `issue:${i.id}`,
          kind: 'issue',
          rank: i.severity === 'error' ? 2 : i.severity === 'warning' ? 3 : 6,
          severity: i.severity,
          title: i.title,
          sub: i.awaitingConfirmation
            ? `${humanize(i.awaitingConfirmation.status)} by ${nameOf(i.awaitingConfirmation.by)}, waiting for a reviewer or partner to confirm: “${i.awaitingConfirmation.resolution}”`
            : i.detail,
          area: i.area ?? areaOf(i.nodeIds),
          nodeId: primaryNode(i.nodeIds),
          issue: i,
          right: i.effect ? fmtEffect(i.effect) : undefined,
        });
    for (const q of questions.data ?? [])
      if (q.status === 'open') {
        const mine = q.to === actorId;
        out.push({
          key: `q:${q.id}`,
          kind: 'question',
          rank: mine ? 3 : 5.5,
          severity: mine ? 'warning' : 'info',
          title: q.thread[0]?.text ?? '',
          sub: mine ? `Asked of you by ${nameOf(q.by)}` : `Waiting on ${nameOf(q.to)} · asked by ${nameOf(q.by)}`,
          area: areaOf(q.nodeIds),
          nodeId: primaryNode(q.nodeIds),
        });
      }
    for (const d of docs.data ?? [])
      if (!d.disposition)
        out.push({
          key: `doc:${d.id}`,
          kind: 'document',
          rank: 4.5,
          severity: 'warning',
          title: `${d.id} ${d.title}`,
          sub: `Feeds no line and has no disposition. Say why it was not used.`,
          go: () => navigate(`/documents/${d.id}`),
        });
    return out.sort((a, b) => a.rank - b.rank);
  }, [notes.data, signoffs.data, proposed.data, issues.data, questions.data, docs.data, actorId, isPartner, areaOf, nameOf, navigate, areas.data]);

  const closed = (issues.data ?? [])
    .filter((i) => i.status !== 'open' && (area === 'all' ? true : area === 'none' ? !i.area : i.area === area))
    .sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''));
  const visible = items.filter((i) => (area === 'all' ? true : area === 'none' ? !i.area : i.area === area) && (kinds.size === 0 || kinds.has(i.kind)));

  const openItem = (it: Item) => (it.go ? it.go() : it.nodeId ? drawer.open(it.nodeId) : undefined);
  const toggle = (it: Item) => {
    if (!it.issue) return;
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(it.issue!.id)) n.delete(it.issue!.id);
      else n.add(it.issue!.id);
      return n;
    });
  };
  const [cursor, setCursor] = useListNav(visible.length, {
    Enter: () => visible[cursor] && openItem(visible[cursor]!),
    x: () => visible[cursor] && toggle(visible[cursor]!),
    v: () => visible[cursor]?.nodeId && drawer.open(visible[cursor]!.nodeId!, { act: 'verify' }),
    a: () => visible[cursor]?.nodeId?.startsWith('line:') && drawer.open(visible[cursor]!.nodeId!, { act: 'adjust' }),
    n: () => visible[cursor]?.nodeId && drawer.open(visible[cursor]!.nodeId!, { act: 'note' }),
  });
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [cursor]);

  // Drop selections that are no longer open/visible.
  const selectedIssues = [...selected].filter((id) => visible.some((v) => v.issue?.id === id));
  const loading = issues.isLoading || notes.isLoading || docs.isLoading;
  const s = summary.data?.status;
  const counts = (k: Kind) => items.filter((i) => i.kind === k).length;

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl font-semibold">What needs you</h1>
          <p className="text-sm text-graphite">
            {loading ? 'Gathering open work…' : `${items.length} open items, most urgent first.`}
            {issues.data && (
              <span className="ml-1">
                Open issues: <span className="font-semibold text-pencil">{issues.data.filter((i) => i.status === 'open' && i.source === 'check').length} found by our checks</span>,{' '}
                {issues.data.filter((i) => i.status === 'open' && i.source === 'engine').length} flagged by the engine
                {issues.data.some((i) => i.status === 'open' && i.source === 'human') && `, ${issues.data.filter((i) => i.status === 'open' && i.source === 'human').length} raised by people`}.
              </span>
            )}
            {s && s.blockingNotes > 0 &&<span className="ml-1 font-semibold text-pencil">Filing is blocked by {s.blockingNotes} review note(s).</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <select className="input w-auto" value={area} onChange={(e) => setArea(e.target.value)} aria-label="Filter by area">
            <option value="all">All areas</option>
            {areas.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.title}
              </option>
            ))}
            <option value="none">Return-wide / no line</option>
          </select>
        </div>
      </div>

      <div className="mb-3 flex gap-1 border-b border-rule" role="tablist">
        {(['open', 'closed'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={clsx('-mb-px border-b-2 px-3 py-1.5 text-sm', tab === t ? 'border-ink font-semibold' : 'border-transparent text-graphite hover:text-ink')} onClick={() => setTab(t)}>
            {t === 'open' ? 'Open' : 'Resolved & accepted'} <span className="num text-xs text-faint">{t === 'open' ? items.length : closed.length}</span>
          </button>
        ))}
      </div>

      {tab === 'closed' ? (
        closed.length === 0 ? (
          <Empty>No closed issues{area !== 'all' ? ' in this area' : ''} yet.</Empty>
        ) : (
          <ul className="overflow-hidden rounded border border-rule bg-panel" aria-label="Closed issues">
            {closed.map((i) => (
              <li key={i.id} className="flex items-start gap-3 border-b border-ruleSoft px-3 py-2 last:border-0">
                <span className="mt-1.5"><SeverityDot severity={i.severity} /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-2xs">
                    <span className="font-semibold text-ledger">{humanize(i.status)}</span>
                    <SourceChip source={i.source} />
                    {i.area && <span className="text-faint">{areaTitle(i.area)}</span>}
                  </div>
                  <button className="mt-0.5 text-left text-sm leading-snug hover:underline" onClick={() => drawer.open(primaryNode(i.nodeIds)!)}>{i.title}</button>
                  <ClosureLine issue={i} />
                </div>
                <IssueClosureButtons issue={i} />
              </li>
            ))}
          </ul>
        )
      ) : (
      <>
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by kind">
        {(Object.keys(KIND_LABEL) as Kind[]).map((k) => {
          const on = kinds.has(k);
          const c = counts(k);
          return (
            <button
              key={k}
              aria-pressed={on}
              onClick={() =>
                setKinds((s) => {
                  const n = new Set(s);
                  if (n.has(k)) n.delete(k);
                  else n.add(k);
                  return n;
                })
              }
              className={clsx('rounded-full border px-2.5 py-0.5 text-xs', on ? 'border-ink bg-ink text-white' : 'border-rule bg-panel text-graphite hover:border-graphite', c === 0 && 'opacity-50')}
            >
              {KIND_LABEL[k]} <span className="num">{c}</span>
            </button>
          );
        })}
      </div>

      {selectedIssues.length > 0 && can('resolve') && (
        <div className="sticky top-0 z-10 mb-2 flex items-center gap-2 rounded border border-ink bg-ink px-3 py-1.5 text-sm text-white">
          <span className="font-semibold">{selectedIssues.length} issue(s) selected</span>
          <span className="flex-1" />
          <button className="rounded bg-white px-2 py-0.5 font-semibold text-ink" onClick={() => setBulk('resolved')}>
            Resolve
          </button>
          <button className="rounded border border-white/60 px-2 py-0.5" onClick={() => setBulk('accepted')}>
            Accept as is
          </button>
          <button className="px-2 py-0.5 opacity-80 hover:opacity-100" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}

      {loading ? (
        <Loading what="your queue" />
      ) : visible.length === 0 ? (
        <Empty>Nothing open here. Pick another area, or open the return map to review lines.</Empty>
      ) : (
        <ul ref={listRef} className="overflow-hidden rounded border border-rule bg-panel" role="listbox" aria-label="Work queue">
          {visible.map((it, i) => (
            <li
              key={it.key}
              data-idx={i}
              role="option"
              aria-selected={i === cursor}
              className={clsx(
                'group flex cursor-pointer items-start gap-3 border-b border-ruleSoft px-3 py-2 last:border-0',
                i === cursor ? 'bg-blue-soft' : 'hover:bg-paper',
                it.severity === 'blocking' && 'border-l-4 border-l-pencil',
              )}
              onClick={() => {
                setCursor(i);
                openItem(it);
              }}
            >
              <span className="mt-1 w-4 shrink-0">
                {it.issue && can('resolve') ? (
                  <input
                    type="checkbox"
                    aria-label="Select issue"
                    checked={selected.has(it.issue.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggle(it)}
                  />
                ) : (
                  <SeverityDot severity={it.severity} />
                )}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-2xs">
                  {it.issue && <SeverityDot severity={it.issue.severity} />}
                  <span className={clsx('font-semibold', it.severity === 'blocking' || it.kind === 'signoff' ? 'text-pencil' : 'text-graphite')}>{KIND_LABEL[it.kind]}</span>
                  {it.issue && <SourceChip source={it.issue.source} />}
                  {it.area && <span className="text-faint">{areaTitle(it.area)}</span>}
                </div>
                <div className="mt-0.5 text-sm leading-snug">{it.title}</div>
                {it.sub && <div className="mt-0.5 line-clamp-2 text-xs text-graphite">{it.sub}</div>}
              </div>
              {it.right && <div className="num max-w-[200px] shrink-0 text-right text-xs text-graphite">{it.right}</div>}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-faint">
        <Kbd>j</Kbd> <Kbd>k</Kbd> move · <Kbd>Enter</Kbd> open trace · <Kbd>x</Kbd> select issue · <Kbd>v</Kbd> verify · <Kbd>n</Kbd> note. Engine diagnostics and our own checks are marked
        apart, so you can see what the engine missed.
      </p>
      </>
      )}

      {bulk && (
        <ReasonDialog
          title={`${bulk === 'resolved' ? 'Resolve' : 'Accept'} ${selectedIssues.length} issue(s)`}
          label={bulk === 'resolved' ? 'What was done' : 'Why they are acceptable as is'}
          confirm={bulk === 'resolved' ? 'Resolve all' : 'Accept all'}
          onClose={() => setBulk(null)}
          onSubmit={async (reason) => {
            await run(() => api<CommandResult>('/api/issues/resolve', { method: 'POST', body: { issueIds: selectedIssues, status: bulk, resolution: reason } }), {
              done: `${selectedIssues.length} issue(s) ${bulk}`,
            });
            setSelected(new Set());
          }}
        >
          <ul className="mb-3 max-h-40 list-disc overflow-auto pl-5 text-sm text-graphite">
            {selectedIssues.map((id) => (
              <li key={id}>{issues.data?.find((x) => x.id === id)?.title}</li>
            ))}
          </ul>
        </ReasonDialog>
      )}
    </div>
  );
}
