// In-memory projection of the event log (D-04). Rebuilt from scratch by replay;
// updated incrementally on append. Undo is a full rebuild that skips undone events.

import type {
  AdjustmentDto,
  AttachmentDto,
  ReadCorrectionDto,
  DispositionDto,
  IssueDto,
  JudgmentDto,
  QuestionDto,
  ReviewNoteDto,
  SignoffDto,
  WorkEvent,
} from '@easetax/shared';
import { parseLineId } from '@easetax/shared';
import type { Graph } from '../graph/graph.ts';
import { areaOfKey } from '../baseline/areas.ts';

interface Stamped {
  by: string;
  at: string;
}

export interface VerificationRec extends Stamped {
  id: string;
  nodeId: string;
  type: string;
  note?: string;
  evidence: string[];
  valueAtVerification: unknown;
  seq: number;
}

export class WorkState {
  seq = 0;
  undone = new Set<string>();
  verifications = new Map<string, VerificationRec>();
  adjustments = new Map<string, AdjustmentDto>();
  /** nodeId -> approved adjustment currently in force */
  activeAdjustment = new Map<string, string>();
  corrections = new Map<string, ReadCorrectionDto>();
  /** ev id (e.g. "ev-1045") -> correction currently in force */
  activeCorrection = new Map<string, string>();
  issueStatus = new Map<string, { status: 'resolved' | 'accepted' | 'open'; resolution?: string } & Stamped>();
  humanIssues = new Map<string, IssueDto>();
  notes = new Map<string, ReviewNoteDto>();
  questions = new Map<string, QuestionDto>();
  attachments = new Map<string, AttachmentDto>();
  evidence: { id: string; nodeId: string; evidenceId: string; note?: string; by: string; at: string }[] = [];
  links: { id: string; from: string; to: string; linkType: string; note?: string; by: string; at: string }[] = [];
  judgments = new Map<string, JudgmentDto>();
  dispositions = new Map<string, DispositionDto>();
  areaConsidered = new Map<string, Stamped & { note?: string }>();
  varianceExplanations = new Map<string, Stamped & { explanation: string }>();
  reconciliations = new Map<string, Stamped & { explanation: string; status: string }>();
  signoffs = new Map<string, SignoffDto & { scopeHash: string }>();
  assignments = new Map<string, { id: string; scope: string; assignee: string; due?: string; text: string; done: boolean } & Stamped>();
  time: { actor: string; area: string; hours: number; note?: string; at: string }[] = [];
  accessLog: { actor: string; nodeId: string; field: string; reason?: string; at: string }[] = [];
  standards: unknown = null;
  lastSeen = new Map<string, number>();
  filingSteps: { step: string; data?: unknown; by: string; at: string; seq: number }[] = [];
  history = new Map<string, WorkEvent[]>();
  events: WorkEvent[] = [];

  constructor(private graph: Graph) {}

  rebuild(events: WorkEvent[]) {
    this.graph.clearUserEdges();
    const fresh = new WorkState(this.graph);
    // Collect undo targets first so replay skips them deterministically.
    for (const e of events) {
      if (e.type === 'events.undone') for (const id of (e.payload as { eventIds: string[] }).eventIds) fresh.undone.add(id);
    }
    for (const e of events) fresh.apply(e);
    Object.assign(this, fresh);
  }

  apply(e: WorkEvent) {
    this.seq = Math.max(this.seq, e.seq);
    this.events.push(e);
    if (this.undone.has(e.id)) return;
    const stamp = { by: e.actor, at: e.at };
    const p: any = e.payload;

    switch (e.type) {
      case 'verification.added':
        this.verifications.set(p.verificationId, { id: p.verificationId, nodeId: p.nodeId, type: p.type, note: p.note, evidence: p.evidence ?? [], valueAtVerification: p.valueAtVerification, seq: e.seq, ...stamp });
        this.touch(p.nodeId, e);
        break;
      case 'verification.removed': {
        const v = this.verifications.get(p.verificationId);
        if (v) {
          this.verifications.delete(p.verificationId);
          this.touch(v.nodeId, e);
        }
        break;
      }
      case 'adjustment.proposed': {
        const adj: AdjustmentDto = {
          id: p.adjustmentId,
          nodeId: p.nodeId,
          originalValue: p.originalValue,
          newValue: p.newValue,
          reason: e.reason ?? '',
          authority: p.authority,
          effect: p.effect,
          requiresPartner: p.requiresPartner,
          status: p.requiresPartner ? 'proposed' : 'approved',
          ...stamp,
        };
        if (!p.requiresPartner) {
          adj.decidedBy = 'policy';
          adj.decidedAt = e.at;
        }
        this.adjustments.set(adj.id, adj);
        this.touch(p.nodeId, e);
        if (adj.status === 'approved') this.activate(adj, e);
        break;
      }
      case 'adjustment.approved':
      case 'adjustment.rejected': {
        const adj = this.adjustments.get(p.adjustmentId);
        if (!adj) break;
        adj.status = e.type === 'adjustment.approved' ? 'approved' : 'rejected';
        adj.decidedBy = e.actor;
        adj.decidedAt = e.at;
        this.touch(adj.nodeId, e);
        if (adj.status === 'approved') this.activate(adj, e);
        break;
      }
      case 'adjustment.reverted': {
        const adj = this.adjustments.get(p.adjustmentId);
        if (!adj) break;
        const wasActive = this.activeAdjustment.get(adj.nodeId) === adj.id;
        adj.status = 'reverted';
        adj.decidedBy = e.actor;
        adj.decidedAt = e.at;
        if (wasActive) {
          this.activeAdjustment.delete(adj.nodeId);
          this.reopenSignoffs([adj.nodeId], e);
        }
        this.touch(adj.nodeId, e);
        break;
      }
      case 'read.corrected': {
        const prev = this.activeCorrection.get(p.evId);
        if (prev) this.corrections.get(prev)!.status = 'reverted';
        this.corrections.set(p.correctionId, {
          id: p.correctionId,
          evId: p.evId,
          originalValue: p.originalValue,
          correctedValue: p.correctedValue,
          valueType: p.valueType,
          reason: e.reason ?? '',
          status: 'in_force',
          ...stamp,
        });
        this.activeCorrection.set(p.evId, p.correctionId);
        this.touchWithLines(`ev:${p.evId}`, e);
        // What the return rests on changed: sign-offs over lines fed by this value reopen.
        this.reopenSignoffs([`ev:${p.evId}`], e);
        break;
      }
      case 'read.correction_reverted': {
        const c = this.corrections.get(p.correctionId);
        if (!c || c.status !== 'in_force') break;
        c.status = 'reverted';
        if (this.activeCorrection.get(c.evId) === c.id) this.activeCorrection.delete(c.evId);
        this.touchWithLines(`ev:${c.evId}`, e);
        this.reopenSignoffs([`ev:${c.evId}`], e);
        break;
      }
      case 'issue.raised':
        this.humanIssues.set(p.issueId, { id: p.issueId, source: 'human', code: 'HUMAN', title: p.title, detail: p.detail, severity: p.severity, nodeIds: p.nodeIds, status: 'open' });
        for (const n of p.nodeIds) this.touch(n, e);
        break;
      case 'issue.resolved':
        this.issueStatus.set(p.issueId, { status: p.status, resolution: p.resolution, ...stamp });
        break;
      case 'issue.reopened':
        this.issueStatus.set(p.issueId, { status: 'open', ...stamp });
        break;
      case 'note.created':
        this.notes.set(p.noteId, { id: p.noteId, nodeIds: p.nodeIds, blocking: p.blocking, status: 'open', thread: [{ by: e.actor, at: e.at, text: p.text }], ...stamp });
        for (const n of p.nodeIds) this.touch(n, e);
        break;
      case 'note.replied':
        this.notes.get(p.noteId)?.thread.push({ by: e.actor, at: e.at, text: p.text });
        break;
      case 'note.resolved':
      case 'note.reopened': {
        const n = this.notes.get(p.noteId);
        if (n) n.status = e.type === 'note.resolved' ? 'resolved' : 'open';
        break;
      }
      case 'question.asked':
        this.questions.set(p.questionId, { id: p.questionId, to: p.to, nodeIds: p.nodeIds, status: 'open', thread: [{ by: e.actor, at: e.at, text: p.text }], ...stamp });
        for (const n of p.nodeIds) this.touch(n, e);
        break;
      case 'question.answered': {
        const q = this.questions.get(p.questionId);
        if (q) {
          q.thread.push({ by: e.actor, at: e.at, text: p.text });
          q.status = 'answered';
          // An answer is evidence on every node the question was about.
          for (const n of q.nodeIds) {
            this.evidence.push({ id: e.id, nodeId: n, evidenceId: `question:${q.id}`, note: p.text, ...stamp });
            this.touch(n, e);
          }
        }
        break;
      }
      case 'question.closed': {
        const q = this.questions.get(p.questionId);
        if (q) q.status = 'closed';
        break;
      }
      case 'attachment.added':
        this.attachments.set(p.attachmentId, { id: p.attachmentId, kind: p.kind, name: p.name, mime: p.mime, size: p.size, text: p.text, ...stamp });
        break;
      case 'evidence.linked':
        this.evidence.push({ id: e.id, nodeId: p.nodeId, evidenceId: p.evidenceId, note: p.note, ...stamp });
        this.graph.addEdge(p.nodeId, p.evidenceId, 'evidences');
        this.touch(p.nodeId, e);
        break;
      case 'link.created':
        this.links.push({ id: p.linkId, from: p.from, to: p.to, linkType: p.linkType, note: p.note, ...stamp });
        this.graph.addEdge(p.from, p.to, 'related');
        this.touch(p.from, e);
        this.touch(p.to, e);
        break;
      case 'judgment.recorded':
        this.judgments.set(p.judgmentId, { id: p.judgmentId, kind: p.kind, topic: p.topic, decision: p.decision, alternatives: p.alternatives, authority: p.authority, nodeIds: p.nodeIds, effect: p.effect, ...stamp });
        for (const n of p.nodeIds) this.touch(n, e);
        break;
      case 'disposition.set':
        this.dispositions.set(p.documentId, { documentId: p.documentId, status: p.status, note: p.note ?? e.reason, derived: false, ...stamp });
        this.touch(`doc:${p.documentId}`, e);
        break;
      case 'area.considered':
        this.areaConsidered.set(p.areaId, { note: p.note, ...stamp });
        break;
      case 'variance.explained':
        this.varianceExplanations.set(p.nodeId, { explanation: p.explanation, ...stamp });
        this.touch(p.nodeId, e);
        break;
      case 'reconciliation.explained':
        this.reconciliations.set(p.reconciliationId, { explanation: p.explanation, status: p.status, ...stamp });
        break;
      case 'signoff.recorded':
        // A newer sign-off at the same scope and level replaces the older one.
        for (const s of this.signoffs.values()) {
          if (s.scope === p.scope && s.level === p.level && s.status === 'valid') s.status = 'withdrawn';
        }
        this.signoffs.set(p.signoffId, { id: p.signoffId, scope: p.scope, level: p.level, scopeHash: p.scopeHash, status: 'valid', ...stamp });
        break;
      case 'signoff.withdrawn': {
        const s = this.signoffs.get(p.signoffId);
        if (s) s.status = 'withdrawn';
        break;
      }
      case 'assignment.created':
        this.assignments.set(p.assignmentId, { id: p.assignmentId, scope: p.scope, assignee: p.assignee, due: p.due, text: p.text, done: false, ...stamp });
        break;
      case 'assignment.completed': {
        const a = this.assignments.get(p.assignmentId);
        if (a) a.done = true;
        break;
      }
      case 'time.logged':
        this.time.push({ actor: e.actor, area: p.area, hours: p.hours, note: p.note, at: e.at });
        break;
      case 'sensitive.unmasked':
        this.accessLog.push({ actor: e.actor, nodeId: p.nodeId, field: p.field, reason: e.reason, at: e.at });
        break;
      case 'firm.standards_updated':
        this.standards = p.standards;
        break;
      case 'seen.marked':
        this.lastSeen.set(e.actor, p.seq);
        break;
      case 'filing.step':
        this.filingSteps.push({ step: p.step, data: p.data, by: e.actor, at: e.at, seq: e.seq });
        break;
      case 'events.undone':
      case 'signoff.reopened':
        break;
    }
  }

  private activate(adj: AdjustmentDto, e: WorkEvent) {
    const prev = this.activeAdjustment.get(adj.nodeId);
    if (prev && prev !== adj.id) {
      const p = this.adjustments.get(prev);
      if (p && p.status === 'approved') p.status = 'reverted';
    }
    this.activeAdjustment.set(adj.nodeId, adj.id);
    this.reopenSignoffs([adj.nodeId], e);
  }

  /**
   * A value changed: reopen every valid sign-off whose scope contains the node or any
   * line that depends on it (D-04 / design §7.3).
   */
  private reopenSignoffs(changed: string[], e: WorkEvent) {
    const affected = new Set<string>(changed);
    for (const c of changed) for (const d of this.graph.dependents(c, (id) => id.startsWith('line:'))) affected.add(d);
    const areas = new Set<string>();
    for (const id of affected) {
      const l = parseLineId(id);
      if (l) areas.add(areaOfKey(l.key));
    }
    for (const s of this.signoffs.values()) {
      if (s.status !== 'valid') continue;
      const hit = s.scope === 'return' || (s.scope.startsWith('area:') && areas.has(s.scope.slice(5)));
      if (hit) {
        s.status = 'reopened';
        s.reopenedBySeq = e.seq;
        s.changedNodeIds = changed;
      }
    }
  }

  /** Record the event on a source and on every line that cites it directly. */
  private touchWithLines(nodeId: string, e: WorkEvent) {
    this.touch(nodeId, e);
    for (const p of this.graph.parents(nodeId)) if (p.type === 'sourced_from' && p.to.startsWith('line:')) this.touch(p.to, e);
  }

  private touch(nodeId: string, e: WorkEvent) {
    const list = this.history.get(nodeId);
    if (list) list.push(e);
    else this.history.set(nodeId, [e]);
  }

  /** The correction in force for an extracted value (raw id, e.g. "ev-1045"). */
  correctionFor(evId: string): ReadCorrectionDto | undefined {
    const id = this.activeCorrection.get(evId);
    return id ? this.corrections.get(id) : undefined;
  }

  effectiveAdjustment(nodeId: string): AdjustmentDto | undefined {
    const id = this.activeAdjustment.get(nodeId);
    return id ? this.adjustments.get(id) : undefined;
  }
}
