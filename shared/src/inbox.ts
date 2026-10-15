// Per-person inbox (FR "assignments, deadlines, notifications"): things that need *this* person,
// derived on the server from the event log. Distinct from "since I last looked", which lists
// everything others did.

export type InboxKind =
  /** An assignment.created naming you as assignee. */
  | 'assigned'
  /** A note or reply whose text says @<your staff id> or your full name. */
  | 'mentioned'
  /** A question addressed to you (staff id, or 'client' for client users). */
  | 'question'
  /** Someone answered a question you asked. */
  | 'answer'
  /** A sign-off you gave was reopened because something under it changed. */
  | 'signoff_reopened'
  /** Partner: an adjustment over the threshold waits for your approval. */
  | 'approval_needed'
  /** Reviewer/partner: a blocking note was raised on an area you had signed. */
  | 'blocking_note'
  /** Your adjustment was approved or rejected. */
  | 'adjustment_decided'
  /** Someone replied to your blocking note. */
  | 'note_replied'
  /** Client: the partner signed the return, so it is ready for your approval. */
  | 'approval_opened'
  /** Client: your approval no longer covers the return (it changed, or the partner's sign-off was reopened). */
  | 'approval_stale';

export interface InboxItemDto {
  /** Stable: derived from the causing event id and the recipient (plus a suffix where one event yields several items). */
  id: string;
  kind: InboxKind;
  /** One line, masked like all outbound text (D-10). */
  title: string;
  /** Optional second line (e.g. the note or question text), masked. */
  detail?: string;
  at: string;
  /** Who caused it (staff/client id, or 'policy'). */
  actor: string;
  /** The causing event's seq, for ordering and "jump to" in the event log. */
  seq: number;
  /** Nodes to open in the trace drawer; always empty for client users (D-35). */
  nodeIds: string[];
  /** Where to go when there is no node (assignment scope, filing, sign-offs). */
  route?: string;
  /** Assignment due date (YYYY-MM-DD), if any. */
  due?: string;
  /** No longer needs action (assignment done, question answered, adjustment decided, note resolved). */
  done: boolean;
  /**
   * Read by this person. Until the core grows a `notification.read` event this is always false
   * from the server and the web app overlays its own per-actor read marks.
   */
  read: boolean;
}

export interface InboxDto {
  actor: string;
  /** Newest first. */
  items: InboxItemDto[];
}
