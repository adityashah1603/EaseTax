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
  /** Filed and no amendment opened since: value-changing work is refused. */
  frozen: boolean;
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

// ------------------------------------------------------------------ roll-forward

/** One year's figure in an item's history (2024 prior year → 2025 → 2026 opening). */
export interface RollHistoryPoint {
  year: number;
  label: string;
  value: unknown;
  /** Where the figure lives (py:, line:, asset:, ev:); absent for the 2026 opening itself. */
  nodeId?: string;
  note?: string;
}

/** A 2025 workpaper event that changed or decided something an item rests on. */
export interface RollChange {
  id: string;
  kind: 'adjustment' | 'judgment' | 'read_correction' | 'variance_explanation' | 'issue' | 'note' | 'question';
  summary: string;
  /** The node it acted on (opens the trace drawer). */
  nodeId?: string;
  status?: string;
  by?: string;
  at?: string;
}

/** Where a roll-forward item came from in 2025, and how it got there. */
export interface RollProvenance {
  /** Node ids (line:, py:, asset:, ev:, doc:, diag:, household:) and issue / judgment / note ids the item came from. */
  sources: string[];
  /** The drawer-openable node to open when the item is clicked. */
  primary?: string;
  history: RollHistoryPoint[];
  changes: RollChange[];
}

export interface RollCarryover extends RollProvenance {
  jurisdiction: 'federal' | 'california';
  key: string;
  label: string;
  amount: number;
  /** Primary source node (kept for older readers). */
  from: string;
  note?: string;
}

export interface RollBasis extends RollProvenance {
  what: string;
  amount: number;
  from: string;
  note?: string;
}

export interface RollAsset extends RollProvenance {
  assetId: string;
  description: string;
  activity: string;
  cost: number;
  placedInService: string;
  method: string;
  lifeYears: number;
  federalAccumulated: number;
  californiaAccumulated: number;
  from: string;
}

export interface RollDisposedAsset extends RollProvenance {
  assetId: string;
  description: string;
  disposed: string;
  from: string;
}

export interface RollOpenItem extends RollProvenance {
  kind: 'issue' | 'question' | 'note' | 'outside_filing' | 'engine_diagnostic' | 'judgment' | 'prior_preparer';
  /** The issue / note / question / judgment / outside-filing id, when the item is one. */
  id?: string;
  text: string;
  nodeIds: string[];
}

export interface RollPlanningItem extends RollProvenance {
  key: string;
  label: string;
  amount?: number;
  text?: string;
}

export interface RollInstallment {
  due: string;
  amount: number;
}

export interface RollEstimatePlan {
  safeHarbor?: string;
  priorYearTax: { amount: number; from: string };
  requiredAnnualPayment: number;
  installments: RollInstallment[];
}

export interface RollforwardDocument {
  schema: 'easetax.rollforward/1';
  fromYear: number;
  toYear: number;
  clientId: string;
  /** D-28: built from the filed snapshot when there is one, else from the live workpaper. */
  builtFrom: { kind: 'filed_snapshot' | 'live_workpaper'; snapshotId?: string; accepted?: boolean; seq: number; text: string };
  sourceSnapshot: { id: string; contentHash: string; seq: number } | null;
  engineVersion: string;
  carryovers: RollCarryover[];
  basis: RollBasis[];
  assets: RollAsset[];
  disposedAssets: RollDisposedAsset[];
  openItems: RollOpenItem[];
  planning: {
    basis: string;
    federal: RollEstimatePlan;
    california: RollEstimatePlan;
    minimumTaxCredit?: { amount: number; from: string; note: string };
    knownChanges: string[];
    note: string;
    /** The planning figures and known changes, each with what they rest on. */
    items: RollPlanningItem[];
  };
}
