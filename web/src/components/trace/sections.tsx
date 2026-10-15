// The record around a node: issues, adjustments, notes, questions, evidence, history.
import type { AdjustmentDto, CommandResult, HouseholdCorrectionDto, IssueDto, NodeDetail, QuestionDto, ReadCorrectionDto, ReviewNoteDto, VerificationDto, WorkEvent } from '@easetax/shared';
import clsx from 'clsx';
import { Lightbulb } from 'lucide-react';
import { useState } from 'react';
import { api } from '../../api/client';
import { useStandards } from '../../api/hooks';
import { fmtDateTime, fmtEffect, fmtValue, humanize, variance } from '../../lib/format';
import { useDrawer } from '../../state/drawer';
import { useSession } from '../../state/session';
import { useToast } from '../../state/toast';
import { ReasonDialog, useCommand } from '../actions';
import { ErrorBox, SeverityDot, SourceChip, Tick } from '../ui';

export function Section({ title, count, children, right }: { title: string; count?: number; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="border-t border-rule py-3">
      <div className="mb-1.5 flex items-center justify-between">
        <h3 className="section-title">
          {title}
          {count !== undefined && <span className="ml-1.5 font-normal text-faint">{count}</span>}
        </h3>
        {right}
      </div>
      {children}
    </section>
  );
}

export function IssueCard({ issue, currentNodeId }: { issue: IssueDto; currentNodeId: string }) {
  const { can } = useSession();
  const drawer = useDrawer();
  const run = useCommand();
  const toast = useToast();
  const [resolving, setResolving] = useState<null | 'resolved' | 'accepted'>(null);
  const open = issue.status === 'open';
  return (
    <div className={clsx('mb-2 rounded border px-3 py-2', open ? 'border-rule bg-panel' : 'border-ruleSoft bg-paper opacity-80')}>
      <div className="flex items-start gap-2">
        <span className="mt-1.5">
          <SeverityDot severity={issue.severity} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <SourceChip source={issue.source} />
            <span className="text-2xs text-faint">{issue.code}</span>
            {!open && <span className="text-2xs font-semibold text-ledger">{issue.status}</span>}
          </div>
          <div className="mt-0.5 text-sm">{issue.title}</div>
          {issue.detail && <div className="mt-0.5 text-xs text-graphite">{issue.detail}</div>}
          {issue.effect && <div className="num mt-0.5 text-xs text-graphite">{fmtEffect(issue.effect)}</div>}
          {issue.resolution && <div className="mt-1 text-xs text-graphite">Resolution: {issue.resolution}</div>}
          {issue.suggestion && open && (
            <div className="mt-1.5 flex flex-wrap items-center gap-2 rounded bg-ledger-soft px-2 py-1 text-xs">
              <Lightbulb size={12} className="text-ledger" />
              <span>
                Suggested value <span className="num font-semibold">{fmtValue(issue.suggestion.value)}</span>: {issue.suggestion.why}
              </span>
              {can('adjust') && (
                <button
                  className="font-semibold text-ledger-ink underline underline-offset-2"
                  onClick={() =>
                    drawer.open(issue.suggestion!.nodeId, {
                      act: issue.suggestion!.nodeId.startsWith('ev:') ? 'correct' : 'adjust',
                      src: issue.suggestion!.nodeId === currentNodeId ? drawer.src ?? undefined : undefined,
                      prefill: { value: String(issue.suggestion!.value), reason: `${issue.code}: ${issue.suggestion!.why}` },
                    })
                  }
                >
                  {issue.suggestion.nodeId.startsWith('ev:') ? 'Correct the read' : 'Apply suggestion'}
                </button>
              )}
            </div>
          )}
        </div>
        {can('resolve') && (
          <div className="flex shrink-0 gap-1">
            {open ? (
              <>
                <button className="btn-ghost text-xs" onClick={() => setResolving('resolved')}>
                  Resolve
                </button>
                <button className="btn-ghost text-xs" onClick={() => setResolving('accepted')} title="Accept as is, with a reason">
                  Accept
                </button>
              </>
            ) : (
              <button
                className="btn-ghost text-xs"
                onClick={() =>
                  run(() => api<CommandResult>(`/api/issues/${encodeURIComponent(issue.id)}/reopen`, { method: 'POST' }), { done: 'Issue reopened' }).catch((e) => toast.error(e))
                }
              >
                Reopen
              </button>
            )}
          </div>
        )}
      </div>
      {resolving && (
        <ReasonDialog
          title={resolving === 'resolved' ? 'Resolve issue' : 'Accept issue'}
          label={resolving === 'resolved' ? 'What was done' : 'Why it is acceptable as is'}
          confirm={resolving === 'resolved' ? 'Resolve' : 'Accept'}
          onClose={() => setResolving(null)}
          onSubmit={(reason) =>
            run(() => api<CommandResult>('/api/issues/resolve', { method: 'POST', body: { issueIds: [issue.id], status: resolving, resolution: reason } }), {
              done: resolving === 'resolved' ? 'Issue resolved' : 'Issue accepted',
            })
          }
        >
          <p className="mb-3 text-sm text-graphite">{issue.title}</p>
        </ReasonDialog>
      )}
    </div>
  );
}

const ADJ_STATUS: Record<AdjustmentDto['status'], { text: string; cls: string }> = {
  proposed: { text: 'Waiting for partner', cls: 'bg-amber-soft text-amber-ink' },
  approved: { text: 'In force', cls: 'bg-blue-soft text-blue-ink' },
  rejected: { text: 'Rejected', cls: 'bg-ruleSoft text-graphite' },
  reverted: { text: 'Reverted', cls: 'bg-ruleSoft text-graphite' },
};

export function AdjustmentCard({ a }: { a: AdjustmentDto }) {
  const { can, nameOf } = useSession();
  const run = useCommand();
  const [deciding, setDeciding] = useState<null | 'approve' | 'reject' | 'revert'>(null);
  const st = ADJ_STATUS[a.status];
  return (
    <div className="mb-2 rounded border border-rule bg-panel px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="num">
          <span className="text-faint line-through">{fmtValue(a.originalValue)}</span>
          <span className="mx-1.5 text-faint">to</span>
          <span className="font-semibold text-blue-ink">{fmtValue(a.newValue)}</span>
        </div>
        <span className={clsx('rounded px-1.5 text-2xs font-semibold', st.cls)}>{st.text}</span>
      </div>
      <div className="mt-1">{a.reason}</div>
      {a.authority && <div className="text-xs text-graphite">Authority: {a.authority}</div>}
      <div className="num mt-1 text-xs text-graphite">
        {fmtEffect(a.effect)} <span className="text-faint">({a.effect.basis})</span>
      </div>
      {a.effect.warnings.map((w) => (
        <div key={w} className="text-xs text-amber-ink">
          {w}
        </div>
      ))}
      <div className="mt-1 text-xs text-faint">
        {nameOf(a.by)}, {fmtDateTime(a.at)}
        {a.requiresPartner && ' · needs partner approval (over 1,000)'}
        {a.decidedBy && a.status !== 'proposed' && ` · ${a.status} by ${nameOf(a.decidedBy)} ${fmtDateTime(a.decidedAt)}`}
      </div>
      <div className="mt-1.5 flex gap-1">
        {a.status === 'proposed' && can('approve') && (
          <>
            <button className="btn text-xs" onClick={() => setDeciding('approve')}>
              Approve
            </button>
            <button className="btn text-xs" onClick={() => setDeciding('reject')}>
              Reject
            </button>
          </>
        )}
        {a.status === 'approved' && can('adjust') && (
          <button className="btn-ghost text-xs" onClick={() => setDeciding('revert')}>
            Revert to engine value
          </button>
        )}
      </div>
      {deciding && (
        <ReasonDialog
          title={deciding === 'approve' ? 'Approve adjustment' : deciding === 'reject' ? 'Reject adjustment' : 'Revert adjustment'}
          label="Note"
          confirm={humanize(deciding)}
          onClose={() => setDeciding(null)}
          onSubmit={(note) =>
            run(() => api<CommandResult>(`/api/adjustments/${a.id}/${deciding}`, { method: 'POST', body: { note } }), {
              done: deciding === 'approve' ? 'Adjustment approved and in force' : deciding === 'reject' ? 'Adjustment rejected' : 'Adjustment reverted',
            })
          }
        />
      )}
    </div>
  );
}

/** A correction to what the pipeline read: original kept, who and why, revertible. */
export function CorrectionCard({ c, showField }: { c: ReadCorrectionDto; showField?: boolean }) {
  const { can, nameOf } = useSession();
  const drawer = useDrawer();
  const run = useCommand();
  const [reverting, setReverting] = useState(false);
  const inForce = c.status === 'in_force';
  return (
    <div className="mb-2 rounded border border-rule bg-panel px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="num">
          <span className="text-faint line-through">{fmtValue(c.originalValue)}</span>
          <span className="mx-1.5 text-faint">to</span>
          <span className="font-semibold text-blue-ink">{fmtValue(c.correctedValue)}</span>
        </div>
        <span className={clsx('rounded px-1.5 text-2xs font-semibold', inForce ? 'bg-blue-soft text-blue-ink' : 'bg-ruleSoft text-graphite')}>
          {inForce ? 'In force' : 'Reverted'}
        </span>
      </div>
      <div className="mt-1">{c.reason}</div>
      <div className="mt-1 text-xs text-faint">
        Read corrected by {nameOf(c.by)}, {fmtDateTime(c.at)}
        {showField && (
          <>
            {' · '}
            <button className="underline underline-offset-2" onClick={() => drawer.open(`ev:${c.evId}`)}>
              {c.evId}
            </button>
          </>
        )}
      </div>
      {inForce && can('verify') && (
        <div className="mt-1.5">
          <button className="btn-ghost text-xs" onClick={() => setReverting(true)}>
            Revert to the pipeline's read
          </button>
        </div>
      )}
      {reverting && (
        <ReasonDialog
          title="Revert correction"
          label="Why"
          confirm="Revert"
          onClose={() => setReverting(false)}
          onSubmit={(reason) =>
            run(() => api<CommandResult>(`/api/reads/corrections/${c.id}/revert`, { method: 'POST', body: { reason } }), { done: 'Correction reverted' })
          }
        />
      )}
    </div>
  );
}

/** A correction to client-entered household data, with the client confirmation it relied on. */
export function RecordCorrectionCard({ c }: { c: HouseholdCorrectionDto }) {
  const { can, nameOf } = useSession();
  const drawer = useDrawer();
  const run = useCommand();
  const [reverting, setReverting] = useState(false);
  const inForce = c.status === 'in_force';
  return (
    <div className="mb-2 rounded border border-rule bg-panel px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="num">
          <span className="mr-1.5 text-xs text-graphite">{c.field.toUpperCase()}</span>
          <span className="text-faint line-through">{fmtValue(c.originalValue)}</span>
          <span className="mx-1.5 text-faint">to</span>
          <span className="font-semibold text-blue-ink">{fmtValue(c.correctedValue)}</span>
        </div>
        <span className={clsx('rounded px-1.5 text-2xs font-semibold', inForce ? 'bg-blue-soft text-blue-ink' : 'bg-ruleSoft text-graphite')}>{inForce ? 'In force' : 'Reverted'}</span>
      </div>
      <div className="mt-1">{c.reason}</div>
      <div className="mt-1 text-xs text-faint">
        Corrected by {nameOf(c.by)}, {fmtDateTime(c.at)} · client confirmation{' '}
        {c.evidenceId.startsWith('msg:') ? (
          <button className="underline underline-offset-2" onClick={() => drawer.open(c.evidenceId)}>
            {c.evidenceId}
          </button>
        ) : (
          <span>{c.evidenceId}</span>
        )}
      </div>
      {inForce && can('verify') && (
        <div className="mt-1.5">
          <button className="btn-ghost text-xs" onClick={() => setReverting(true)}>
            Revert to the client's original entry
          </button>
        </div>
      )}
      {reverting && (
        <ReasonDialog
          title="Revert correction"
          label="Why"
          confirm="Revert"
          onClose={() => setReverting(false)}
          onSubmit={(reason) => run(() => api<CommandResult>(`/api/household/corrections/${c.id}/revert`, { method: 'POST', body: { reason } }), { done: 'Correction reverted' })}
        />
      )}
    </div>
  );
}

export function NoteCard({ n }: { n: ReviewNoteDto }) {
  const { can, nameOf } = useSession();
  const run = useCommand();
  const [reply, setReply] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const act = async (action: 'reply' | 'resolve' | 'reopen') => {
    setErr(null);
    try {
      await run(() => api<CommandResult>(`/api/notes/${n.id}/${action}`, { method: 'POST', body: action === 'reply' ? { text: reply } : {} }), {
        done: action === 'reply' ? 'Reply added' : action === 'resolve' ? 'Note cleared' : 'Note reopened',
      });
      setReply('');
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <div className={clsx('mb-2 rounded border px-3 py-2 text-sm', n.blocking && n.status === 'open' ? 'border-pencil' : 'border-rule')}>
      <div className="mb-1 flex items-center gap-2 text-2xs">
        {n.blocking && <span className="rounded bg-pencil px-1.5 font-semibold text-white">Blocking</span>}
        <span className={n.status === 'open' ? 'font-semibold text-amber-ink' : 'text-ledger'}>{n.status === 'open' ? 'Open' : 'Cleared'}</span>
      </div>
      {n.thread.map((t, i) => (
        <div key={i} className={clsx(i > 0 && 'mt-1.5 border-l-2 border-rule pl-2')}>
          <div>{t.text}</div>
          <div className="text-xs text-faint">
            {nameOf(t.by)}, {fmtDateTime(t.at)}
          </div>
        </div>
      ))}
      {can('note') && (
        <div className="mt-2 flex gap-1">
          {n.status === 'open' && (
            <input className="input text-xs" placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && reply.trim() && act('reply')} />
          )}
          {n.status === 'open' ? (
            <button className="btn shrink-0 text-xs" onClick={() => act('resolve')}>
              Clear note
            </button>
          ) : (
            <button className="btn-ghost shrink-0 text-xs" onClick={() => act('reopen')}>
              Reopen
            </button>
          )}
        </div>
      )}
      {err ? <div className="mt-1.5"><ErrorBox error={err} /></div> : null}
    </div>
  );
}

export function QuestionCard({ q }: { q: QuestionDto }) {
  const { actorId, actor, nameOf } = useSession();
  const run = useCommand();
  const [answer, setAnswer] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const mayAnswer = q.status === 'open' && (q.to === actorId || (q.to === 'client' && (actor?.kind === 'client' || ['preparer', 'reviewer', 'partner'].includes(actor?.role ?? ''))));
  return (
    <div className="mb-2 rounded border border-rule px-3 py-2 text-sm">
      <div className="mb-1 flex items-center gap-2 text-2xs text-graphite">
        <span>
          To <span className="font-semibold">{nameOf(q.to)}</span>
        </span>
        <span className={q.status === 'open' ? 'font-semibold text-amber-ink' : 'text-ledger'}>{q.status === 'open' ? 'Waiting for answer' : humanize(q.status)}</span>
      </div>
      {q.thread.map((t, i) => (
        <div key={i} className={clsx(i > 0 && 'mt-1.5 border-l-2 border-ledger pl-2')}>
          <div>{t.text}</div>
          <div className="text-xs text-faint">
            {nameOf(t.by)}, {fmtDateTime(t.at)}
            {i > 0 && ' · kept as evidence on this item'}
          </div>
        </div>
      ))}
      {mayAnswer && (
        <form
          className="mt-2 flex gap-1"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            try {
              await run(() => api<CommandResult>(`/api/questions/${q.id}/answer`, { method: 'POST', body: { text: answer } }), { done: 'Answer recorded' });
              setAnswer('');
            } catch (x) {
              setErr(x);
            }
          }}
        >
          <input
            className="input text-xs"
            placeholder={actor?.kind === 'client' || q.to === actorId ? 'Your answer…' : "Record the client's answer (e.g. from a call)…"}
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <button className="btn shrink-0 text-xs" disabled={!answer.trim()}>
            Answer
          </button>
        </form>
      )}
      {err ? <div className="mt-1.5"><ErrorBox error={err} /></div> : null}
    </div>
  );
}

export function VersionsRow({ versions, current }: { versions: NonNullable<NodeDetail['versions']>; current: unknown }) {
  const std = useStandards();
  const vr = std.data?.variance_review;
  const py = versions.find((v) => v.version === '2024');
  const vv = variance(current, py?.value, vr?.flag_if_change_over_percent, vr?.and_over_amount);
  return (
    <div>
      <div className="grid grid-cols-4 gap-px overflow-hidden rounded border border-rule bg-rule text-sm">
        {versions.map((v, i) => {
          const prev = i > 0 ? versions[i - 1] : undefined;
          const changed = prev && v.version !== '2024' && JSON.stringify(prev.value) !== JSON.stringify(v.value);
          return (
            <div key={v.version} className={clsx('bg-panel px-2 py-1.5', v.version === '2024' && 'bg-paper')}>
              <div className="text-2xs text-graphite">{v.version === '2024' ? 'Prior year 2024' : `Engine ${v.version}`}</div>
              <div className={clsx('num', changed && 'font-semibold text-blue-ink', v.value === undefined && 'text-faint')}>{v.value === undefined ? 'not on return' : fmtValue(v.value)}</div>
              {changed && <div className="text-2xs text-blue-ink">changed from {prev!.version}</div>}
            </div>
          );
        })}
      </div>
      {vv && (
        <div className={clsx('num mt-1 text-xs', vv.flagged ? 'font-semibold text-amber-ink' : 'text-graphite')}>
          vs 2024: {vv.delta >= 0 ? '+' : '−'}
          {fmtValue(Math.abs(vv.delta))}
          {vv.pct !== null && ` (${vv.pct >= 0 ? '+' : ''}${vv.pct.toFixed(1)}%)`}
          {vv.flagged && ` · over the firm threshold (${vr?.flag_if_change_over_percent}% and ${vr?.and_over_amount}); needs an explanation`}
        </div>
      )}
    </div>
  );
}

export function VerificationList({ items }: { items: VerificationDto[] }) {
  const { nameOf, can } = useSession();
  const run = useCommand();
  const toast = useToast();
  if (!items.length) return <div className="text-sm text-faint">Not verified yet. Press v to verify.</div>;
  return (
    <ul className="space-y-1">
      {items.map((v) => (
        <li key={v.id} className={clsx('flex items-start gap-2 rounded px-1 py-0.5 text-sm', v.stale && 'bg-amber-soft')}>
          <span className="mt-0.5">
            <Tick stale={v.stale} />
          </span>
          <div className="min-w-0 flex-1">
            <span className="font-medium">{humanize(v.type)}</span>
            <span className="text-graphite">
              {' '}
              by {nameOf(v.by)}, {fmtDateTime(v.at)}
            </span>
            {v.note && <div className="text-xs text-graphite">{v.note}</div>}
            {v.stale && (
              <div className="num text-xs font-semibold text-amber-ink">
                Stale: verified at {fmtValue(v.valueAtVerification)}; the value has changed since. Verify again.
              </div>
            )}
          </div>
          {can('verify') && (
            <button
              className="btn-ghost text-xs"
              onClick={() => run(() => api<CommandResult>(`/api/verifications/${v.id}`, { method: 'DELETE' }), { done: 'Verification removed' }).catch((e) => toast.error(e))}
            >
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

const EVENT_TEXT: Partial<Record<WorkEvent['type'], string>> = {
  'verification.added': 'verified',
  'verification.removed': 'removed a verification',
  'adjustment.proposed': 'proposed an adjustment',
  'adjustment.approved': 'approved the adjustment',
  'adjustment.rejected': 'rejected the adjustment',
  'adjustment.reverted': 'reverted the adjustment',
  'note.created': 'added a review note',
  'note.replied': 'replied to a note',
  'note.resolved': 'cleared a note',
  'question.asked': 'asked a question',
  'question.answered': 'answered',
  'evidence.linked': 'linked evidence',
  'issue.resolved': 'resolved an issue',
  'events.undone': 'undid an action',
};

export function HistoryList({ events }: { events: WorkEvent[] }) {
  const { nameOf } = useSession();
  if (!events.length) return <div className="text-sm text-faint">No work recorded on this item yet.</div>;
  return (
    <ol className="space-y-1 text-sm">
      {[...events].reverse().map((e) => (
        <li key={e.id} className="flex gap-2">
          <span className="num w-[108px] shrink-0 text-xs text-faint">{fmtDateTime(e.at)}</span>
          <span className="min-w-0">
            <span className="font-medium">{nameOf(e.actor)}</span> <span className="text-graphite">{EVENT_TEXT[e.type] ?? humanize(e.type)}</span>
            {e.type === 'verification.added' && <span className="text-graphite"> ({humanize((e.payload as { type: string }).type).toLowerCase()})</span>}
            {e.type === 'adjustment.proposed' && (
              <span className="num text-graphite"> to {fmtValue((e.payload as { newValue: unknown }).newValue)}</span>
            )}
            {e.reason && <span className="block text-xs text-graphite">“{e.reason}”</span>}
            <span className="text-2xs text-faint"> #{e.seq}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}
