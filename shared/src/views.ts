// DTOs for the generated CPA views (FR-8) and the filing lifecycle (FR-6).
// Views are lenses over the graph, never separately maintained data: every number a view
// shows carries the node id it came from so the UI can open the trace drawer on it.

export type CellKind = 'money' | 'cents' | 'number' | 'percent' | 'ratio' | 'text' | 'date' | 'status';

export interface ViewCell {
  /** The value the workpaper stands behind: for lines, after approved adjustments. */
  value: unknown;
  /** The engine's / source's value, shown next to `value` when a line is adjusted. */
  engineValue?: unknown;
  /** Graph node the number came from (line:, ev:, py:, agency:, ref:, asset:, doc: ...). */
  nodeId?: string;
  adjusted?: boolean;
  note?: string;
}

export interface ViewColumn {
  key: string;
  label: string;
  kind: CellKind;
}

export interface ViewFlag {
  code: string;
  severity: 'info' | 'warning' | 'error';
  text: string;
  nodeIds?: string[];
}

export interface ViewRow {
  id: string;
  label: string;
  sublabel?: string;
  /** The row's primary node (opens the trace drawer). */
  nodeId?: string;
  cells: Record<string, ViewCell | undefined>;
  flags?: ViewFlag[];
  status?: string;
  /** Related nodes (evidence, judgments' nodes, documents). */
  links?: string[];
  children?: ViewRow[];
}

export interface ViewSection {
  id: string;
  title: string;
  note?: string;
  columns: ViewColumn[];
  rows: ViewRow[];
  totals?: ViewRow[];
}

export interface ViewDto {
  id: string;
  title: string;
  description: string;
  version: string;
  /** Event-log position the view reflects. */
  seq: number;
  findings: ViewFlag[];
  sections: ViewSection[];
  meta?: Record<string, unknown>;
}

export interface ViewListItem {
  id: string;
  title: string;
  description: string;
}

// ------------------------------------------------------------------ filing

export interface ReadinessStepDto {
  step: string;
  ok: boolean;
  /** 'manual' = no rule maps this step; it is satisfied by recording it as done. */
  kind: 'computed' | 'manual';
  reason?: string;
  nodeIds?: string[];
}

export interface ReadinessDto {
  ready: boolean;
  seq: number;
  steps: ReadinessStepDto[];
  /** Live blockers beyond required_steps (open blocking notes, pending partner approvals). */
  blockers: { code: string; text: string; nodeIds?: string[] }[];
}

export interface SubmissionDto {
  id: string;
  jurisdiction: 'federal' | 'california';
  snapshotId: string;
  contentHash: string;
  submittedBy: string;
  submittedAt: string;
  status: 'pending' | 'accepted' | 'rejected' | 'not_transmitted';
  agencySubmissionId?: string;
  errors?: { code: string; message: string }[];
  resultAt?: string;
}

export interface SnapshotMetaDto {
  id: string;
  kind: string;
  at: string;
  seq: number;
  contentHash: string;
}

export interface FilingStatusDto {
  extension: { federal: number; california: number; by: string; at: string } | null;
  clientApproval: { by: string; at: string; pins: Record<string, string>; returnHash: string; current: boolean } | null;
  /** Whether the client may approve now (D-48: only after a valid partner sign-off on the return). */
  approvalOpen: { open: boolean; reason?: string };
  submissions: SubmissionDto[];
  snapshots: SnapshotMetaDto[];
  amendments: { id: string; baseSnapshotId: string; baseSeq: number; reason?: string; by: string; at: string }[];
  noticeCases: { caseId: string; noticeId: string; snapshotId: string; contentHash: string; by: string; at: string }[];
  filed: boolean;
}

export interface FrozenLine {
  key: string;
  form: string;
  line: string;
  label: string;
  jurisdiction: string;
  engineValue: unknown;
  value: unknown;
  adjusted: boolean;
}
