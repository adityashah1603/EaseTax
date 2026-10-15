// Record a judgment call, election, due diligence or penalty decision. The server requires
// the authority relied on (firm rule) and its refusal is shown verbatim.
import type { CommandResult, JudgmentDto, JudgmentKind } from '@easetax/shared';
import clsx from 'clsx';
import { Link2, Plus, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { api } from '../../api/client';
import { useNode, useSearch, useStandards } from '../../api/hooks';
import { AUTHORITY_RULE, JUDGMENT_KINDS, KIND_LABEL } from '../../api/judgmentHooks';
import { fmtDateTime } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { useSession } from '../../state/session';
import { useCommand } from '../actions';
import { ErrorBox, Field, Modal } from '../ui';

export interface JudgmentDraft {
  kind: JudgmentKind;
  topic?: string;
  decision?: string;
  alternatives?: string[];
  nodeIds?: string[];
  /** Placeholder for the authority field; never prefilled as a value (the preparer states it). */
  authorityHint?: string;
  /** Shown above the form, e.g. the engine's numbers for each option. */
  context?: ReactNode;
}

/** A linked node by its label; opens the trace. Falls back to the id while loading. */
export function LinkedItem({ nodeId, onRemove }: { nodeId: string; onRemove?: () => void }) {
  const drawer = useDrawer();
  const n = useNode(nodeId);
  const node = n.data?.node;
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded border border-rule bg-panel px-1.5 py-0.5 text-xs">
      {/* In the dialog (onRemove set) the chip does not navigate: opening a trace would drop the draft. */}
      <button
        type="button"
        className={clsx('min-w-0 truncate text-left', !onRemove && 'hover:text-blue-ink hover:underline')}
        title={onRemove ? nodeId : `${nodeId}: open its trace`}
        onClick={() => !onRemove && drawer.open(nodeId)}
      >
        {node ? (
          <>
            {node.sublabel && <span className="text-graphite">{node.sublabel} </span>}
            {node.label}
          </>
        ) : (
          <span className="text-graphite">{nodeId}</span>
        )}
      </button>
      {onRemove && (
        <button type="button" className="shrink-0 text-faint hover:text-pencil" onClick={onRemove} aria-label={`Unlink ${nodeId}`}>
          <X size={11} />
        </button>
      )}
    </span>
  );
}

export function JudgmentDialog({ draft, currentNodeId, onClose }: { draft: JudgmentDraft; currentNodeId?: string | null; onClose: () => void }) {
  const standards = useStandards();
  const rule = standards.data?.rules.find((r) => /judgment call/i.test(r)) ?? AUTHORITY_RULE;
  const [kind, setKind] = useState<JudgmentKind>(draft.kind);
  const [topic, setTopic] = useState(draft.topic ?? '');
  const [decision, setDecision] = useState(draft.decision ?? '');
  const [alts, setAlts] = useState<string[]>(draft.alternatives?.length ? draft.alternatives : []);
  const [authority, setAuthority] = useState('');
  const [nodeIds, setNodeIds] = useState<string[]>(draft.nodeIds ?? []);
  const [q, setQ] = useState('');
  const search = useSearch(q);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCommand();
  const addNode = (id: string) => setNodeIds((s) => (s.includes(id) ? s : [...s, id]));

  return (
    <Modal title="Record judgment" onClose={onClose} width={620}>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await run(
              () =>
                api<CommandResult>('/api/judgments', {
                  method: 'POST',
                  body: { kind, topic: topic.trim(), decision: decision.trim(), alternatives: alts.map((a) => a.trim()).filter(Boolean), authority, nodeIds },
                }),
              { done: `${KIND_LABEL[kind]} recorded: ${topic.trim()}` },
            );
            onClose();
          } catch (err) {
            setError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        {draft.context && <div className="mb-3">{draft.context}</div>}
        <Field label="Kind">
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Kind">
            {JUDGMENT_KINDS.map((k) => (
              <label key={k} className={clsx('btn cursor-pointer', kind === k && 'border-ink bg-ruleSoft font-semibold')}>
                <input type="radio" name="jkind" className="sr-only" checked={kind === k} onChange={() => setKind(k)} />
                {KIND_LABEL[k]}
              </label>
            ))}
          </div>
        </Field>
        <Field label="Topic" hint="What had to be decided.">
          <input className="input" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. HVAC replacement: repair or capital improvement" />
        </Field>
        <Field label="Decision" hint="What you decided and why, in a sentence or two.">
          <textarea className="input" rows={3} value={decision} onChange={(e) => setDecision(e.target.value)} />
        </Field>
        <div className="mb-3">
          <span className="mb-1 block text-xs font-semibold text-graphite">Alternatives considered</span>
          {alts.map((a, i) => (
            <div key={i} className="mb-1 flex items-start gap-1">
              <textarea
                className="input"
                rows={a.length > 80 ? 2 : 1}
                value={a}
                aria-label={`Alternative ${i + 1}`}
                onChange={(e) => setAlts((s) => s.map((x, k) => (k === i ? e.target.value : x)))}
              />
              <button type="button" className="btn-ghost mt-0.5" onClick={() => setAlts((s) => s.filter((_, k) => k !== i))} aria-label={`Remove alternative ${i + 1}`}>
                <X size={14} />
              </button>
            </div>
          ))}
          <button type="button" className="btn-ghost text-xs" onClick={() => setAlts((s) => [...s, ''])}>
            <Plus size={12} /> Add alternative
          </button>
        </div>
        <Field label="Authority relied on (required)" hint={`Firm rule: ${rule}`}>
          <input className="input" value={authority} onChange={(e) => setAuthority(e.target.value)} placeholder={draft.authorityHint ?? 'Code section, regulation, or firm policy'} />
        </Field>
        <div className="mb-3">
          <span className="mb-1 block text-xs font-semibold text-graphite">Linked items</span>
          <div className="mb-1.5 flex flex-wrap gap-1">
            {nodeIds.length === 0 && <span className="text-xs text-faint">None linked yet.</span>}
            {nodeIds.map((id) => (
              <LinkedItem key={id} nodeId={id} onRemove={() => setNodeIds((s) => s.filter((x) => x !== id))} />
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {currentNodeId && !nodeIds.includes(currentNodeId) && (
              <button type="button" className="btn text-xs" onClick={() => addNode(currentNodeId)}>
                <Link2 size={12} /> Link the item open in the trace
              </button>
            )}
            <input className="input max-w-[260px] text-xs" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a line or document to link…" aria-label="Find an item to link" />
          </div>
          {search.data && search.data.length > 0 && q.trim().length >= 2 && (
            <ul className="mt-1 max-h-36 overflow-auto rounded border border-rule bg-panel">
              {search.data.slice(0, 12).map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    className="w-full px-2 py-1 text-left text-sm hover:bg-ruleSoft disabled:text-faint"
                    disabled={nodeIds.includes(r.id)}
                    onClick={() => {
                      addNode(r.id);
                      setQ('');
                    }}
                  >
                    <span className="text-graphite">{r.sublabel}</span> {r.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <ErrorBox error={error} />
        <div className="mt-3 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          {/* Authority is left enabled-empty on purpose: the server enforces the rule and its refusal is shown verbatim. */}
          <button className="btn-primary" disabled={busy || !topic.trim() || !decision.trim()}>
            Record {KIND_LABEL[kind].toLowerCase()}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** One recorded judgment: topic, decision, alternatives, authority, who/when, linked items. */
export function JudgmentCard({ j, compact }: { j: JudgmentDto; compact?: boolean }) {
  const { nameOf } = useSession();
  return (
    <div className="mb-2 rounded border border-rule bg-panel px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="text-sm font-semibold">
          {compact && <span className="mr-1.5 text-2xs font-normal uppercase tracking-wide text-faint">{KIND_LABEL[j.kind]}</span>}
          {j.topic}
        </div>
        <div className="text-xs text-faint">
          {nameOf(j.by)} · {fmtDateTime(j.at)}
        </div>
      </div>
      <div className="mt-0.5 text-sm">{j.decision}</div>
      {j.alternatives.length > 0 && (
        <div className="mt-1 text-xs text-graphite">
          <span className="font-semibold">Alternatives considered</span>
          <ul className="ml-4 list-disc">
            {j.alternatives.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="mt-1 text-xs text-graphite">
        <span className="font-semibold">Authority</span> {j.authority}
      </div>
      {!compact && j.nodeIds.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {j.nodeIds.map((id) => (
            <LinkedItem key={id} nodeId={id} />
          ))}
        </div>
      )}
    </div>
  );
}
