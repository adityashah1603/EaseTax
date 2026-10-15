// The trace drawer (design §7.12): any node, its formula tree and where it lands on the
// left, the highlighted source page on the right, and the record of human work below.
import type { CommandResult, NodeDetail, TraceNode } from '@easetax/shared';
import { parseLineId } from '@easetax/shared';
import clsx from 'clsx';
import { ArrowLeft, Check, Eye, FileCheck2, Gavel, HelpCircle, Link2, MessageSquarePlus, Paperclip, PenLine, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api/client';
import { useNode, useSummary, useTrace } from '../../api/hooks';
import { useJudgments } from '../../api/judgmentHooks';
import { JudgmentCard, JudgmentDialog } from '../workflow/JudgmentDialog';
import { useHotkeys } from '../../lib/hotkeys';
import { fmtValue, isMasked, NODE_KIND_LABEL } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { useSession } from '../../state/session';
import { useStream } from '../../state/stream';
import { useToast } from '../../state/toast';
import { AdjustDialog, AskDialog, CorrectReadDialog, EvidenceDialog, NoteDialog, ReasonDialog, VerifyDialog } from '../actions';
import { ErrorBox, Kbd, Loading, Marks, Tick } from '../ui';
import { flatten, FormulaTree, isSourceLeaf, type FlatRow } from './FormulaTree';
import { AdjustmentCard, CorrectionCard, HistoryList, IssueCard, NoteCard, QuestionCard, Section, VerificationList, VersionsRow } from './sections';
import { SourcePane } from './SourcePane';

export function TraceDrawer() {
  const drawer = useDrawer();
  if (!drawer.nodeId) return null;
  return <DrawerBody key={drawer.nodeId} nodeId={drawer.nodeId} />;
}

function DrawerBody({ nodeId }: { nodeId: string }) {
  const drawer = useDrawer();
  const navigate = useNavigate();
  const { can, actorId, nameOf, actor } = useSession();
  const { presence } = useStream();
  const detail = useNode(nodeId);
  const down = useTrace(nodeId, 'down', 3);
  const up = useTrace(nodeId, 'up', 4);
  const summary = useSummary();
  const [extraDown, setExtraDown] = useState<Record<string, TraceNode[]>>({});
  const [extraUp, setExtraUp] = useState<Record<string, TraceNode[]>>({});
  const [colDown, setColDown] = useState<Set<string>>(new Set());
  const [colUp, setColUp] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<{ tree: 'down' | 'up'; key: string; id: string } | null>(null);
  const [unmasked, setUnmasked] = useState<unknown>(undefined);
  const [unmasking, setUnmasking] = useState(false);
  // Local, not a URL ?act=: DrawerAction lives in state/drawer.ts, outside this change.
  const [judging, setJudging] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const toast = useToast();

  const d = detail.data;
  const node = d?.node;
  const line = parseLineId(nodeId);
  const isCurrentLine = !!line && line.version === summary.data?.currentVersion;

  // Extracted values start folded: their only children are "page → document", which the
  // source pane already shows when the value is selected.
  useEffect(() => {
    if (!down.data) return;
    setColDown(new Set(flatten(down.data, new Set(), {}).filter((r) => r.t.node.id.startsWith('ev:') && r.t.children.length).map((r) => r.key)));
  }, [down.data]);

  const rowsDown = useMemo(() => (down.data ? flatten(down.data, colDown, extraDown) : []), [down.data, colDown, extraDown]);
  const firstEv = rowsDown.find((r) => r.t.node.id.startsWith('ev:'))?.t.node.id ?? null;
  // The source pane follows the URL (?src=), else the node itself when it is a source,
  // else the first document value the number rests on.
  const sourceId = drawer.src ?? (isSourceLeaf(nodeId) ? nodeId : firstEv);
  const rowsUp = useMemo(() => (up.data ? flatten(up.data, colUp, extraUp) : []), [up.data, colUp, extraUp]);
  const allRows: { tree: 'down' | 'up'; row: FlatRow }[] = useMemo(
    () => [...rowsDown.map((row) => ({ tree: 'down' as const, row })), ...rowsUp.map((row) => ({ tree: 'up' as const, row }))],
    [rowsDown, rowsUp],
  );

  const select = (tree: 'down' | 'up', row: FlatRow) => {
    setSel({ tree, key: row.key, id: row.t.node.id });
    if (isSourceLeaf(row.t.node.id)) drawer.setSrc(row.t.node.id);
  };
  const openNode = (id: string) => drawer.open(id, { src: isSourceLeaf(id) ? id : undefined });

  useEffect(() => {
    if (!sel) return;
    panelRef.current?.querySelector(`[data-row-key="${CSS.escape(sel.key)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const move = (dir: 1 | -1) => {
    if (!allRows.length) return;
    const i = sel ? allRows.findIndex((r) => r.tree === sel.tree && r.row.key === sel.key) : -1;
    const next = allRows[Math.max(0, Math.min(allRows.length - 1, i + dir))]!;
    select(next.tree, next.row);
  };

  useHotkeys({
    Escape: () => (drawer.act ? drawer.setAct(null) : drawer.close()),
    j: () => move(1),
    k: () => move(-1),
    Enter: () => sel && openNode(sel.id),
    v: () => can('verify') && drawer.setAct('verify'),
    a: () => can('adjust') && isCurrentLine && drawer.setAct('adjust'),
    n: () => can('note') && drawer.setAct('note'),
  });

  const label = node ? `${node.sublabel ?? ''} ${node.label}`.trim() : nodeId;
  const watchers = presence.filter((p) => p.focus === nodeId && p.actor !== actorId);
  const openIssues = d?.issues.filter((i) => i.status === 'open') ?? [];
  const closedIssues = d?.issues.filter((i) => i.status !== 'open') ?? [];
  const raw = d?.raw as { rule?: string; note?: string; inputs?: string[]; sources?: string[] } | undefined;
  const display = unmasked !== undefined ? unmasked : node?.effectiveValue ?? node?.value;

  return (
    <>
      <div className="fixed inset-0 z-30 bg-ink/10" onClick={() => drawer.close()} aria-hidden />
      <aside
        ref={panelRef}
        className="drawer-in fixed bottom-0 right-0 top-0 z-40 flex w-[min(1240px,100vw)] flex-col border-l border-rule bg-paper shadow-2xl"
        aria-label="Trace"
      >
        {/* header */}
        <header className="border-b border-rule bg-panel px-5 pb-3 pt-3">
          <div className="flex items-center gap-2 text-xs text-graphite">
            <button className="btn-ghost" onClick={() => navigate(-1)} title="Back">
              <ArrowLeft size={14} />
            </button>
            <span>{NODE_KIND_LABEL[node?.kind ?? ''] ?? node?.kind}</span>
            {node?.version && <span>· engine {node.version}</span>}
            <span className="truncate text-faint">{nodeId}</span>
            <span className="flex-1" />
            {watchers.length > 0 && (
              <span className="inline-flex items-center gap-1 text-blue-ink" title="Also looking at this now">
                <Eye size={12} /> {watchers.map((w) => nameOf(w.actor)).join(', ')}
              </span>
            )}
            <button
              className="btn-ghost"
              title="Copy a link to this number"
              onClick={() => {
                void navigator.clipboard?.writeText(window.location.href);
                toast.push({ tone: 'info', text: 'Link copied. It opens this trace for anyone with access.' });
              }}
            >
              <Link2 size={14} />
            </button>
            <button className="btn-ghost" onClick={() => drawer.close()} aria-label="Close trace">
              <X size={16} /> <Kbd>Esc</Kbd>
            </button>
          </div>
          {detail.error ? (
            <div className="mt-2">
              <ErrorBox error={detail.error} />
            </div>
          ) : !node ? (
            <Loading what="trace" />
          ) : (
            <div className="mt-1 flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                <div className="text-xs text-graphite">{node.sublabel}</div>
                <h2 className="text-lg font-semibold leading-snug">{node.label}</h2>
                {raw?.rule && (
                  <div className="mt-0.5 text-xs text-graphite">
                    Rule <span className="font-semibold">{raw.rule}</span>
                    {raw.note && <span className="ml-2 italic">{raw.note}</span>}
                  </div>
                )}
              </div>
              <div className="text-right">
                <div className="flex items-center justify-end gap-2">
                  <Marks openIssues={node.openIssues} adjusted={node.adjusted} />
                  {node.verified && <Tick stale={d!.verifications.length > 0 && d!.verifications.every((v) => v.stale)} size={18} />}
                  <span className={clsx('num font-serif text-3xl font-semibold', node.adjusted && 'text-blue-ink', isMasked(display) && 'text-graphite')}>{fmtValue(display)}</span>
                </div>
                {node.adjusted && (
                  <div className="num text-xs text-graphite">
                    {node.kind === 'ev' ? 'pipeline read' : 'engine'} <span className="line-through">{fmtValue(node.value)}</span> ·{' '}
                    {node.kind === 'ev' ? 'corrected read shown' : 'workpaper value shown'}
                  </div>
                )}
                {typeof node.confidence === 'number' && (
                  <div className={clsx('text-xs', node.confidence < 0.8 ? 'font-semibold text-amber-ink' : 'text-graphite')}>Read confidence {Math.round(node.confidence * 100)}%</div>
                )}
                {isMasked(node.value) && unmasked === undefined && !actor?.clearance && (
                  <div className="text-xs text-graphite">Masked: you don't have sensitive-data clearance.</div>
                )}
                {isMasked(node.value) && unmasked === undefined && actor?.clearance && (
                  <button className="btn-ghost text-xs" onClick={() => setUnmasking(true)}>
                    Reveal (logged)
                  </button>
                )}
              </div>
            </div>
          )}
          {node && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {can('verify') && (
                <button className="btn" onClick={() => drawer.setAct('verify')}>
                  <Check size={14} /> Verify <Kbd>v</Kbd>
                </button>
              )}
              {can('adjust') && isCurrentLine && (
                <button className="btn" onClick={() => drawer.setAct('adjust')}>
                  <PenLine size={14} /> Adjust <Kbd>a</Kbd>
                </button>
              )}
              {can('verify') && node.kind === 'ev' && (
                <button className="btn" onClick={() => drawer.setAct('correct')} title="Record what the page actually prints; the pipeline's read is kept">
                  <FileCheck2 size={14} /> Correct the read
                </button>
              )}
              {can('note') && (
                <button className="btn" onClick={() => drawer.setAct('note')}>
                  <MessageSquarePlus size={14} /> Note <Kbd>n</Kbd>
                </button>
              )}
              {can('ask') && (
                <button className="btn" onClick={() => drawer.setAct('ask')}>
                  <HelpCircle size={14} /> Ask
                </button>
              )}
              {can('attach') && (
                <button className="btn" onClick={() => drawer.setAct('evidence')}>
                  <Paperclip size={14} /> Link evidence
                </button>
              )}
              {can('verify') && (
                <button className="btn" onClick={() => setJudging(true)} title="Record a judgment call, election, due diligence or penalty decision linked to this item">
                  <Gavel size={14} /> Record judgment
                </button>
              )}
              <span className="ml-auto self-center text-2xs text-faint">
                <Kbd>j</Kbd> <Kbd>k</Kbd> move in the tree · <Kbd>Enter</Kbd> open
              </span>
            </div>
          )}
        </header>

        {/* body */}
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
          <div className="min-h-0 overflow-auto px-5 pb-10">
            {d && openIssues.length > 0 && (
              <Section title="Open issues" count={openIssues.length}>
                {openIssues.map((i) => (
                  <IssueCard key={i.id} issue={i} currentNodeId={nodeId} />
                ))}
              </Section>
            )}
            <Section title={line ? 'How it was built' : 'What it rests on'}>
              {down.isLoading ? (
                <Loading />
              ) : down.data ? (
                <FormulaTree
                  root={down.data}
                  dir="down"
                  selectedKey={sel?.tree === 'down' ? sel.key : null}
                  onSelect={(r) => select('down', r)}
                  onOpen={openNode}
                  extra={extraDown}
                  setExtra={setExtraDown}
                  collapsed={colDown}
                  setCollapsed={setColDown}
                  highlightId={sourceId}
                />
              ) : (
                <ErrorBox error={down.error} />
              )}
            </Section>
            <Section title="Where it landed">
              {up.isLoading ? (
                <Loading />
              ) : up.data ? (
                <FormulaTree
                  root={up.data}
                  dir="up"
                  selectedKey={sel?.tree === 'up' ? sel.key : null}
                  onSelect={(r) => select('up', r)}
                  onOpen={openNode}
                  extra={extraUp}
                  setExtra={setExtraUp}
                  collapsed={colUp}
                  setCollapsed={setColUp}
                  highlightId={sourceId}
                />
              ) : (
                <ErrorBox error={up.error} />
              )}
            </Section>
            {d?.versions && (
              <Section title="Versions">
                <VersionsRow versions={d.versions} current={node?.effectiveValue ?? node?.value} />
              </Section>
            )}
            {d && <WorkRecord d={d} />}
            {d && closedIssues.length > 0 && (
              <Section title="Closed issues" count={closedIssues.length}>
                {closedIssues.map((i) => (
                  <IssueCard key={i.id} issue={i} currentNodeId={nodeId} />
                ))}
              </Section>
            )}
            {d && (
              <Section title="History" count={d.history.length}>
                <HistoryList events={d.history} />
              </Section>
            )}
          </div>
          <div className="min-h-0 overflow-auto border-l border-rule bg-[#EEF1ED] px-4 py-3">
            <SourcePane sourceId={sourceId} onSelectEv={(id) => drawer.setSrc(id)} />
          </div>
        </div>
      </aside>

      {node && drawer.act === 'verify' && <VerifyDialog nodeIds={[nodeId]} label={label} onClose={() => drawer.setAct(null)} />}
      {node && drawer.act === 'adjust' && <AdjustDialog node={node} onClose={() => drawer.setAct(null)} />}
      {node && drawer.act === 'correct' && node.kind === 'ev' && <CorrectReadDialog node={node} onClose={() => drawer.setAct(null)} />}
      {node && drawer.act === 'note' && <NoteDialog nodeIds={[nodeId]} label={label} onClose={() => drawer.setAct(null)} />}
      {node && drawer.act === 'ask' && <AskDialog nodeIds={[nodeId]} label={label} onClose={() => drawer.setAct(null)} />}
      {node && drawer.act === 'evidence' && <EvidenceDialog nodeId={nodeId} onClose={() => drawer.setAct(null)} />}
      {node && judging && <JudgmentDialog draft={{ kind: 'judgment', nodeIds: [nodeId] }} currentNodeId={nodeId} onClose={() => setJudging(false)} />}
      {unmasking && (
        <ReasonDialog
          title="Reveal sensitive value"
          label="Why you need to see it"
          confirm="Reveal"
          onClose={() => setUnmasking(false)}
          onSubmit={async (reason) => {
            const r = await api<CommandResult<{ value: unknown }>>('/api/sensitive/unmask', { method: 'POST', body: { nodeId, field: 'value', reason } });
            setUnmasked(r.data?.value);
          }}
        >
          <p className="mb-3 text-sm text-graphite">This view is logged with your name and reason, and the firm administrator can see it.</p>
        </ReasonDialog>
      )}
    </>
  );
}

function WorkRecord({ d }: { d: NodeDetail }) {
  const drawer = useDrawer();
  const judgments = (useJudgments().data ?? []).filter((j) => j.nodeIds.includes(d.node.id));
  return (
    <>
      <Section title="Verifications" count={d.verifications.length}>
        <VerificationList items={d.verifications} />
      </Section>
      {judgments.length > 0 && (
        <Section title="Judgments" count={judgments.length}>
          {judgments.map((j) => (
            <JudgmentCard key={j.id} j={j} compact />
          ))}
        </Section>
      )}
      {d.corrections.length > 0 && (
        <Section title="Read corrections" count={d.corrections.length}>
          {d.corrections.map((c) => (
            <CorrectionCard key={c.id} c={c} showField={!d.node.id.startsWith('ev:')} />
          ))}
        </Section>
      )}
      {d.adjustments.length > 0 && (
        <Section title="Adjustments" count={d.adjustments.length}>
          {d.adjustments.map((a) => (
            <AdjustmentCard key={a.id} a={a} />
          ))}
        </Section>
      )}
      {d.notes.length > 0 && (
        <Section title="Review notes" count={d.notes.length}>
          {d.notes.map((n) => (
            <NoteCard key={n.id} n={n} />
          ))}
        </Section>
      )}
      {d.questions.length > 0 && (
        <Section title="Questions" count={d.questions.length}>
          {d.questions.map((q) => (
            <QuestionCard key={q.id} q={q} />
          ))}
        </Section>
      )}
      {(d.evidence.length > 0 || d.links.length > 0) && (
        <Section title="Evidence and links" count={d.evidence.length + d.links.length}>
          <ul className="space-y-1 text-sm">
            {d.evidence.map((e) => (
              <li key={e.id} className="flex items-start gap-2">
                <Paperclip size={13} className="mt-0.5 shrink-0 text-faint" />
                <button className="min-w-0 text-left hover:underline" onClick={() => drawer.open(e.node.id, { src: isSourceLeaf(e.node.id) ? e.node.id : undefined })}>
                  <span className="text-graphite">{e.node.sublabel}</span> {e.node.label}
                  {e.note && <span className="block text-xs text-graphite">{e.note}</span>}
                </button>
                {e.node.id.startsWith('att:') && (
                  <a className="btn-ghost shrink-0 text-xs" href={`/api/attachments/${e.node.id.slice(4)}/file`} target="_blank" rel="noreferrer">
                    file
                  </a>
                )}
              </li>
            ))}
            {d.links.map((l) => (
              <li key={l.id} className="flex items-start gap-2">
                <Link2 size={13} className="mt-0.5 shrink-0 text-faint" />
                <button className="text-left hover:underline" onClick={() => drawer.open(l.other.id)}>
                  <span className="text-graphite">{l.linkType}</span> {l.other.label}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}
