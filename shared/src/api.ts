// API contract shared by server and web.

import type { Anchor, CaSummary, FedSummary } from './packet.ts';
import type { DispositionStatus, JudgmentKind, Role, SignoffLevel, WorkEvent } from './events.ts';
import type { EstimatedEffect } from './taxEffect.ts';

export interface Actor {
  id: string;
  name: string;
  role: Role;
  kind: 'staff' | 'client';
  clearance: boolean;
  activeFrom?: string;
  note?: string;
}

export type EdgeType =
  | 'input_of' // line -> line it feeds
  | 'sourced_from' // line -> raw source (ev, qa, py, asset, ref, household...)
  | 'read_from' // ev -> page
  | 'page_of' // page -> doc
  | 'supersedes' // corrected doc -> original
  | 'duplicate_of'
  | 'evidences' // user evidence -> node
  | 'related' // user link
  | 'refers_to'; // diagnostic/timeline ref

export interface NodeSummary {
  id: string;
  kind: string;
  label: string;
  /** Short context such as form/line, document title or field name. */
  sublabel?: string;
  value?: unknown;
  /** Value after approved adjustments (lines only). */
  effectiveValue?: unknown;
  version?: string;
  confidence?: number;
  /** Engine rule and note (lines only). */
  rule?: string;
  note?: string;
  /** Review area (lines, and values that feed lines). */
  area?: string;
  /** Counts used for badges. */
  openIssues?: number;
  verified?: boolean;
  adjusted?: boolean;
}

export interface TraceNode {
  node: NodeSummary;
  edge?: EdgeType;
  children: TraceNode[];
  /** True when depth limit cut off further children. */
  truncated?: boolean;
  /** True when this node already appeared higher in the tree (a DAG join). */
  repeated?: boolean;
}

export interface IssueDto {
  id: string;
  source: 'check' | 'engine' | 'human';
  code: string;
  title: string;
  detail?: string;
  severity: 'info' | 'warning' | 'error';
  nodeIds: string[];
  status: 'open' | 'resolved' | 'accepted';
  resolution?: string;
  /** Estimated tax effect if the check knows the corrected value. */
  effect?: EstimatedEffect;
  /** Set when a recorded judgment closed this issue (D-53). */
  resolvedByJudgment?: string;
  /** Suggested corrected value for a line, if the check computed one. */
  suggestion?: { nodeId: string; value: unknown; why: string };
  area?: string;
}

export interface VerificationDto {
  id: string;
  nodeId: string;
  type: string;
  by: string;
  at: string;
  note?: string;
  evidence: string[];
  valueAtVerification: unknown;
  /** The node's value changed after it was verified. */
  stale: boolean;
}

export interface AdjustmentDto {
  id: string;
  nodeId: string;
  originalValue: unknown;
  newValue: unknown;
  reason: string;
  authority?: string;
  effect: EstimatedEffect;
  requiresPartner: boolean;
  status: 'proposed' | 'approved' | 'rejected' | 'reverted';
  by: string;
  at: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface ThreadEntry {
  by: string;
  at: string;
  text: string;
}

export interface ReadCorrectionDto {
  id: string;
  /** Extracted value id without prefix, e.g. "ev-1045". */
  evId: string;
  originalValue: unknown;
  correctedValue: unknown;
  valueType: string;
  reason: string;
  by: string;
  at: string;
  status: 'in_force' | 'reverted';
}

export interface HouseholdCorrectionDto {
  id: string;
  personId: string;
  field: string;
  originalValue: unknown;
  correctedValue: unknown;
  /** The client's confirmation relied on: question:<id> or msg:<id>. */
  evidenceId: string;
  reason: string;
  by: string;
  at: string;
  status: 'in_force' | 'reverted';
}

export interface ReviewNoteDto {
  id: string;
  nodeIds: string[];
  blocking: boolean;
  status: 'open' | 'resolved';
  thread: ThreadEntry[];
  by: string;
  at: string;
}

export interface QuestionDto {
  id: string;
  to: string;
  nodeIds: string[];
  status: 'open' | 'answered' | 'closed';
  thread: ThreadEntry[];
  by: string;
  at: string;
}

export interface SignoffDto {
  id: string;
  scope: string;
  level: SignoffLevel;
  by: string;
  at: string;
  status: 'valid' | 'reopened' | 'withdrawn';
  reopenedBySeq?: number;
  changedNodeIds?: string[];
}

export interface JudgmentDto {
  id: string;
  kind: JudgmentKind;
  topic: string;
  decision: string;
  alternatives: string[];
  authority: string;
  nodeIds: string[];
  effect?: EstimatedEffect;
  /** Issues this judgment answered and closed (D-53). */
  issueIds?: string[];
  by: string;
  at: string;
}

export interface DispositionDto {
  documentId: string;
  status: DispositionStatus;
  note?: string;
  by: string;
  at: string;
  /** 'system' when derived from the packet (e.g. engine marked superseded). */
  derived: boolean;
}

export interface AttachmentDto {
  id: string;
  kind: 'file' | 'note' | 'message' | 'link';
  name: string;
  mime?: string;
  size?: number;
  text?: string;
  by: string;
  at: string;
}

export interface NodeDetail {
  node: NodeSummary;
  /** Raw payload from the packet for this node (masked per caller). */
  raw: unknown;
  verifications: VerificationDto[];
  adjustments: AdjustmentDto[];
  /** Corrections to what the pipeline read (extracted values only). */
  corrections: ReadCorrectionDto[];
  /** Corrections to client-entered household data (household nodes only). */
  recordCorrections: HouseholdCorrectionDto[];
  issues: IssueDto[];
  notes: ReviewNoteDto[];
  questions: QuestionDto[];
  evidence: { id: string; node: NodeSummary; note?: string; by: string; at: string }[];
  links: { id: string; other: NodeSummary; linkType: string; note?: string }[];
  history: WorkEvent[];
  /** Same line in other engine versions and the 2024 return. */
  versions?: { version: string; value: unknown }[];
}

export interface PageAnchor {
  evId: string;
  field: string;
  label: string;
  value: unknown;
  textAsRead: string;
  anchor: Anchor;
  confidence: number;
  /** A human correction of this read, if one is in force (masked like the value). */
  correctedValue?: unknown;
}

export interface Landing {
  evId: string;
  field: string;
  label: string;
  value: unknown;
  lines: NodeSummary[];
}

export interface DocumentDto {
  id: string;
  title: string;
  documentType: string;
  issuer: string;
  belongsTo: string;
  taxYear: number;
  receivedAt: string;
  uploadedBy: string;
  fileName: string;
  pageCount: number;
  markedCorrected: boolean;
  extraction: { status: string; values: number; reason: string | null };
  /** Rendition descriptor: simulated today, a PDF/image URL when real sources exist (D-14). */
  rendition: { kind: 'simulated' | 'pdf' | 'image'; uri?: string };
  disposition: DispositionDto | null;
  linesFed: number;
  openIssues: number;
}

export interface DocumentDetailDto extends DocumentDto {
  pages: { page: number; printedContent: string; anchors: PageAnchor[] }[];
  landings: Landing[];
  unusedValues: number;
}

export interface ReturnSummaryDto {
  clientId: string;
  name: string;
  taxYear: number;
  packetHash: string;
  currentVersion: string;
  versions: { version: string; computedAt: string; trigger: string; federal: FedSummary; california: CaSummary }[];
  priorYear: { agi: number | null; totalTax: number | null; lines: Record<string, number | string | null> };
  status: {
    openIssues: number;
    blockingNotes: number;
    openQuestions: number;
    pendingAdjustments: number;
    undispositionedDocs: number;
    signoffs: SignoffDto[];
  };
  /** Workpaper adjustments' estimated effect on the current version's totals. */
  adjustmentEffect: { federalTax: number; californiaTax: number; federalBalance: number; californiaBalance: number };
}

export interface AreaDto {
  id: string;
  title: string;
  forms: string[];
  lineCount: number;
  openIssues: number;
  verifiedLines: number;
  adjustedLines: number;
  signoffs: SignoffDto[];
  considered: boolean;
  budgetHours?: number;
  loggedHours: number;
}

export interface LineRow {
  id: string;
  key: string;
  form: string;
  line: string;
  label: string;
  jurisdiction: string;
  value: unknown;
  effectiveValue: unknown;
  priorYear?: unknown;
  rule: string;
  area: string;
  openIssues: number;
  verified: boolean;
  adjusted: boolean;
  notes: number;
}

export interface WhoAmI {
  actor: Actor;
  actors: Actor[];
  clock: { at: string | null; timeline: { id: string; at: string; event: string }[] };
}

export interface CommandResult<T = unknown> {
  ok: true;
  seq: number;
  /** Set when the command wrote a batch; pass to POST /api/undo. */
  batchId?: string;
  /** Ids of the events written, for single-event undo. */
  eventIds: string[];
  data?: T;
}

export interface ApiError {
  ok: false;
  error: string;
  code: 'forbidden' | 'conflict' | 'invalid' | 'not_found' | 'policy';
  /** Policy rule that blocked the action, quoted from firm standards. */
  rule?: string;
}
