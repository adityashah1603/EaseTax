// Per-person inbox: the things that need *this* person, derived purely from the event log and
// its projections (wp.state). Nothing is stored; asking again after any event gives the new
// answer, so the SSE "events" broadcast that invalidates every web query keeps it live.
//
// Distinct from "since I last looked" (GET /api/changes/since-last-seen), which is everything
// others did. Here an event only lands if it is addressed to, about, or blocking the reader.

import type { Actor, InboxDto, InboxItemDto, InboxKind, WorkEvent } from '@easetax/shared';
import { parseLineId } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';
import { AREAS, areaOfKey } from '../baseline/areas.ts';
import { maskFreeText, maskText } from '../policy/policy.ts';
import { filingState } from '../filing/state.ts';

/** What a client user may be told about (D-35): never notes, adjustments or sign-off internals. */
const CLIENT_KINDS = new Set<InboxKind>(['question', 'approval_opened', 'approval_stale']);

/** Events that change a value the return rests on (and so can make a client approval stale). */
const VALUE_CHANGES = new Set<string>([
  'adjustment.proposed',
  'adjustment.approved',
  'adjustment.reverted',
  'read.corrected',
  'read.correction_reverted',
  'household.corrected',
  'household.correction_reverted',
]);

const NO_READS: ReadonlySet<string> = new Set();

/** Notification ids this person has marked read (the `notification.read` projection, D-59). */
export function inboxReadMarks(wp: Workpaper, actorId: string): ReadonlySet<string> {
  return wp.state.inboxRead.get(actorId) ?? NO_READS;
}

export function inboxFor(wp: Workpaper, me: Actor, readIds: ReadonlySet<string> = inboxReadMarks(wp, me.id)): InboxDto {
  const st = wp.state;
  const isClient = me.kind === 'client';
  const nameOf = (id: string) => (id === 'policy' || id === 'system' ? 'Firm policy' : (wp.actors.find((a) => a.id === id)?.name ?? id));
  const label = (id: string | undefined) => (id ? wp.summarize(id).label : 'the return');
  const items = new Map<string, InboxItemDto>();
  const add = (e: WorkEvent, kind: InboxKind, x: Partial<InboxItemDto> & { title: string }, suffix = '') => {
    const id = `${e.id}:${me.id}${suffix}`;
    if (items.has(id)) return; // one item per event and reader; the first (most specific) kind wins
    items.set(id, {
      id,
      kind,
      at: e.at,
      actor: e.actor,
      seq: e.seq,
      nodeIds: [],
      done: false,
      read: readIds.has(id),
      ...x,
    });
  };

  const live = st.events.filter((e) => !st.undone.has(e.id) && e.type !== 'events.undone');
  const bySeq = new Map(live.map((e) => [e.seq, e]));
  /** My sign-offs standing at this point in the log: id -> {scope, level}. */
  const mySignoffs = new Map<string, { scope: string; level: string }>();

  for (const e of live) {
    const p = e.payload as Record<string, any>;
    const mine = e.actor === me.id;
    switch (e.type) {
      case 'assignment.created': {
        if (p.assignee !== me.id || mine) break;
        add(e, 'assigned', {
          title: `Assigned to you: ${p.text}`,
          detail: `${scopeTitle(p.scope)}${p.due ? ` · due ${p.due}` : ''}`,
          due: p.due,
          route: scopeRoute(p.scope),
          done: !!st.assignments.get(p.assignmentId)?.done,
        });
        break;
      }
      case 'note.created': {
        if (isClient || mine) break;
        const done = st.notes.get(p.noteId)?.status === 'resolved';
        const what = `${p.blocking ? 'blocking ' : ''}note on ${label(p.nodeIds[0])}`;
        if (mentions(p.text, me)) {
          add(e, 'mentioned', { title: `${nameOf(e.actor)} mentioned you in a ${what}`, detail: p.text, nodeIds: p.nodeIds, done });
        } else if (p.blocking && (me.role === 'reviewer' || me.role === 'partner') && coversAny(wp, [...mySignoffs.values()], p.nodeIds)) {
          add(e, 'blocking_note', { title: `Blocking note on an area you signed: ${label(p.nodeIds[0])}`, detail: p.text, nodeIds: p.nodeIds, done });
        }
        break;
      }
      case 'note.replied': {
        if (isClient || mine) break;
        const note = st.notes.get(p.noteId);
        if (!note) break;
        const done = note.status === 'resolved';
        if (mentions(p.text, me)) {
          add(e, 'mentioned', { title: `${nameOf(e.actor)} mentioned you in a reply on ${label(note.nodeIds[0])}`, detail: p.text, nodeIds: note.nodeIds, done });
        } else if (note.by === me.id && note.blocking) {
          add(e, 'note_replied', { title: `${nameOf(e.actor)} replied to your blocking note on ${label(note.nodeIds[0])}`, detail: p.text, nodeIds: note.nodeIds, done });
        }
        break;
      }
      case 'question.asked': {
        if (mine) break;
        const forMe = isClient ? p.to === 'client' : p.to === me.id;
        if (!forMe) break;
        const done = st.questions.get(p.questionId)?.status !== 'open';
        if (isClient) add(e, 'question', { title: `A question from ${nameOf(e.actor)}`, detail: p.text, route: '/', done });
        else add(e, 'question', { title: `${nameOf(e.actor)} asked you about ${label(p.nodeIds[0])}`, detail: p.text, nodeIds: p.nodeIds, done });
        break;
      }
      case 'question.answered': {
        if (isClient || mine) break;
        const q = st.questions.get(p.questionId);
        if (!q || q.by !== me.id) break;
        add(e, 'answer', { title: `${nameOf(e.actor)} answered your question on ${label(q.nodeIds[0])}`, detail: p.text, nodeIds: q.nodeIds, done: q.status === 'closed' });
        break;
      }
      case 'adjustment.proposed': {
        if (isClient || mine || me.role !== 'partner' || !p.requiresPartner) break;
        const adj = st.adjustments.get(p.adjustmentId);
        add(e, 'approval_needed', {
          title: `Adjustment awaiting your approval: ${label(p.nodeId)}`,
          detail: `${fmt(p.originalValue)} → ${fmt(p.newValue)} by ${nameOf(e.actor)}${e.reason ? `: ${e.reason}` : ''}`,
          nodeIds: [p.nodeId],
          done: adj?.status !== 'proposed',
        });
        break;
      }
      case 'adjustment.approved':
      case 'adjustment.rejected': {
        if (isClient || mine) break;
        const adj = st.adjustments.get(p.adjustmentId);
        if (!adj || adj.by !== me.id) break;
        const verb = e.type === 'adjustment.approved' ? 'approved' : 'rejected';
        add(e, 'adjustment_decided', { title: `${nameOf(e.actor)} ${verb} your adjustment to ${label(adj.nodeId)}`, detail: p.note, nodeIds: [adj.nodeId], done: true });
        break;
      }
      case 'signoff.recorded': {
        // A newer sign-off at the same scope and level replaces the older one (as in WorkState).
        for (const [id, s] of mySignoffs) if (s.scope === p.scope && s.level === p.level) mySignoffs.delete(id);
        if (mine) mySignoffs.set(p.signoffId, { scope: p.scope, level: p.level });
        if (isClient && p.scope === 'return' && p.level === 'partner') {
          const approvedSince = st.filingSteps.some((f) => f.step === 'client_approval' && f.seq > e.seq);
          add(e, 'approval_opened', { title: 'Your return is ready for your approval', detail: 'The partner has signed off. Review the figures and sign Form 8879.', route: '/', done: approvedSince });
        }
        break;
      }
      case 'signoff.withdrawn':
        mySignoffs.delete(p.signoffId);
        break;
    }
  }

  // A sign-off I gave that something reopened (state.reopenSignoffs records the cause seq).
  if (!isClient) {
    const signoffs = [...st.signoffs.values()];
    for (const s of signoffs) {
      if (s.by !== me.id || s.status !== 'reopened' || s.reopenedBySeq === undefined) continue;
      const cause = bySeq.get(s.reopenedBySeq);
      if (!cause) continue;
      const changed = s.changedNodeIds ?? [];
      const resigned = signoffs.some((o) => o.scope === s.scope && o.level === s.level && o.status === 'valid' && o.at >= s.at && o.id !== s.id);
      add(
        cause,
        'signoff_reopened',
        {
          title: `Your ${s.level} sign-off on ${scopeTitle(s.scope)} was reopened`,
          detail: `${nameOf(cause.actor)} ${CAUSE_TEXT[cause.type] ?? cause.type.replace(/[._]/g, ' ')}: ${changed.map((n) => label(n)).join(', ') || 'the return'}`,
          nodeIds: changed,
          route: changed.length ? undefined : '/signoffs',
          done: resigned,
        },
        `:reopened:${s.id}`,
      );
    }
  }

  // Client: an approval that no longer covers the return.
  if (isClient) {
    const fs = filingState(wp);
    const approval = st.filingSteps.filter((f) => f.step === 'client_approval').at(-1);
    const approvalEvent = approval ? bySeq.get(approval.seq) : undefined;
    if (fs.clientApproval && !fs.clientApproval.current && approval && approvalEvent) {
      const partnerReopen = [...st.signoffs.values()].find((s) => s.scope === 'return' && s.level === 'partner' && s.status === 'reopened' && (s.reopenedBySeq ?? 0) > approval.seq);
      const after = live.filter((e) => e.seq > approval.seq);
      const cause = (partnerReopen && bySeq.get(partnerReopen.reopenedBySeq!)) ?? after.find((e) => VALUE_CHANGES.has(e.type)) ?? after.at(-1) ?? approvalEvent;
      const item = {
        title: 'Your approval needs renewing',
        detail: 'The return changed after you approved it, so your approval no longer covers it. You can sign again once the partner has signed off.',
        route: '/',
      };
      items.set(`${approvalEvent.id}:${me.id}:stale`, { id: `${approvalEvent.id}:${me.id}:stale`, kind: 'approval_stale', at: cause.at, actor: cause.actor, seq: cause.seq, nodeIds: [], done: false, read: false, ...item });
    }
  }

  const out = [...items.values()]
    .filter((i) => !isClient || CLIENT_KINDS.has(i.kind))
    .map((i) => ({
      ...i,
      title: maskText(i.title),
      detail: i.detail ? maskFreeText(String(i.detail)) : undefined,
      nodeIds: isClient ? [] : i.nodeIds,
      read: readIds.has(i.id),
    }))
    .sort((a, b) => b.seq - a.seq || a.id.localeCompare(b.id));
  return { actor: me.id, items: out };
}

const CAUSE_TEXT: Record<string, string> = {
  'adjustment.proposed': 'adjusted',
  'adjustment.approved': 'approved an adjustment to',
  'adjustment.reverted': 'reverted an adjustment to',
  'read.corrected': 'corrected a read on',
  'read.correction_reverted': 'reverted a read correction on',
  'household.corrected': 'corrected the household record for',
  'household.correction_reverted': 'reverted a household correction for',
};

/** True when `text` says @<id> or the person's full name (case-insensitive, whole words). */
export function mentions(text: string | undefined, a: Actor): boolean {
  if (!text) return false;
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[^\\w@-])@${esc(a.id)}(?![\\w-])`, 'i').test(text)) return true;
  return new RegExp(`(^|[^\\w])@?${esc(a.name).replace(/\s+/g, '\\s+')}(?!\\w)`, 'i').test(text);
}

function scopeTitle(scope: string): string {
  if (scope === 'return') return 'the whole return';
  if (scope.startsWith('area:')) return AREAS.find((a) => a.id === scope.slice(5))?.title ?? scope.slice(5);
  return scope;
}

function scopeRoute(scope: string): string {
  if (scope.startsWith('area:')) return `/areas/${encodeURIComponent(scope.slice(5))}`;
  return '/signoffs';
}

/** Whether any standing sign-off (return-wide, or an area's) covers one of the nodes. */
function coversAny(wp: Workpaper, signed: { scope: string }[], nodeIds: string[]): boolean {
  if (!signed.length) return false;
  if (signed.some((s) => s.scope === 'return')) return true;
  const areas = areasOf(wp, nodeIds);
  return signed.some((s) => s.scope.startsWith('area:') && areas.has(s.scope.slice(5)));
}

/** Review areas the nodes fall in: a line's own area, else the areas of current lines they feed. */
function areasOf(wp: Workpaper, nodeIds: string[]): Set<string> {
  const out = new Set<string>();
  const prefix = `line:${wp.version}:`;
  for (const id of nodeIds) {
    const l = parseLineId(id);
    if (l) {
      out.add(areaOfKey(l.key));
      continue;
    }
    const sources = id.startsWith('doc:') && !id.includes('#') ? (wp.b.evsByDoc.get(id.slice(4)) ?? []).map((e) => `ev:${e.id}`) : [id];
    for (const n of sources) for (const p of wp.g.parents(n)) if (p.to.startsWith(prefix)) out.add(areaOfKey(p.to.slice(prefix.length)));
  }
  return out;
}

function fmt(v: unknown): string {
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (v === null || v === undefined) return '—';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}
