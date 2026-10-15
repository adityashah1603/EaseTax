// The workpaper's human layer is an append-only event log (DECISIONS D-04).
// Every write to the system is one of these events; all state is a projection of them.

import type { EstimatedEffect } from './taxEffect.ts';

export type Role = 'preparer' | 'reviewer' | 'partner' | 'firm_administrator' | 'quality_reviewer' | 'client';

export type DispositionStatus = 'used' | 'duplicate' | 'superseded' | 'not_relevant' | 'out_of_year' | 'pending' | 'outside_scope';
export type SignoffLevel = 'preparer' | 'reviewer' | 'partner';
export type JudgmentKind = 'judgment' | 'election' | 'due_diligence' | 'penalty';

export interface EventPayloads {
  'verification.added': { verificationId: string; nodeId: string; type: string; note?: string; evidence: string[]; valueAtVerification: unknown };
  'verification.removed': { verificationId: string };
  'adjustment.proposed': {
    adjustmentId: string;
    nodeId: string;
    originalValue: unknown;
    newValue: unknown;
    authority?: string;
    effect: EstimatedEffect;
    requiresPartner: boolean;
  };
  'adjustment.approved': { adjustmentId: string; note?: string };
  'adjustment.rejected': { adjustmentId: string; note?: string };
  'adjustment.reverted': { adjustmentId: string };
  /** A human corrects what the pipeline read for one extracted value; the original is kept. */
  'read.corrected': { correctionId: string; evId: string; originalValue: unknown; correctedValue: unknown; valueType: string };
  'read.correction_reverted': { correctionId: string };
  'issue.resolved': { issueId: string; status: 'resolved' | 'accepted'; resolution: string };
  'issue.reopened': { issueId: string };
  'issue.raised': { issueId: string; nodeIds: string[]; title: string; detail?: string; severity: 'info' | 'warning' | 'error' };
  'note.created': { noteId: string; nodeIds: string[]; text: string; blocking: boolean };
  'note.replied': { noteId: string; text: string };
  'note.resolved': { noteId: string };
  'note.reopened': { noteId: string };
  'question.asked': { questionId: string; to: string; nodeIds: string[]; text: string };
  'question.answered': { questionId: string; text: string };
  'question.closed': { questionId: string };
  'attachment.added': { attachmentId: string; kind: 'file' | 'note' | 'message' | 'link'; name: string; mime?: string; size?: number; sha256?: string; text?: string };
  'evidence.linked': { nodeId: string; evidenceId: string; note?: string };
  'link.created': { linkId: string; from: string; to: string; linkType: string; note?: string };
  'judgment.recorded': {
    judgmentId: string;
    kind: JudgmentKind;
    topic: string;
    decision: string;
    alternatives: string[];
    authority: string;
    nodeIds: string[];
    effect?: EstimatedEffect;
  };
  'disposition.set': { documentId: string; status: DispositionStatus; note?: string };
  'area.considered': { areaId: string; note?: string };
  'variance.explained': { nodeId: string; explanation: string };
  'reconciliation.explained': { reconciliationId: string; explanation: string; status: 'explained' | 'accepted' };
  'signoff.recorded': { signoffId: string; scope: string; level: SignoffLevel; scopeHash: string };
  'signoff.reopened': { signoffId: string; causeSeq: number; changedNodeIds: string[] };
  'signoff.withdrawn': { signoffId: string };
  'assignment.created': { assignmentId: string; scope: string; assignee: string; due?: string; text: string };
  'assignment.completed': { assignmentId: string };
  'time.logged': { area: string; hours: number; note?: string };
  'sensitive.unmasked': { nodeId: string; field: string };
  'firm.standards_updated': { standards: unknown };
  'seen.marked': { seq: number };
  'events.undone': { eventIds: string[] };
  'filing.step': { step: string; data?: unknown };
}

export type EventType = keyof EventPayloads;

export interface WorkEvent<T extends EventType = EventType> {
  seq: number;
  id: string;
  at: string;
  actor: string;
  role: Role;
  type: T;
  payload: EventPayloads[T];
  reason?: string;
  /** Events written by one bulk action share a batchId so they can be undone together. */
  batchId?: string;
}

export type NewEvent<T extends EventType = EventType> = Omit<WorkEvent<T>, 'seq' | 'id' | 'at' | 'actor' | 'role'>;
