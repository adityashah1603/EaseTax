// Filing lifecycle as a projection of `filing.step` events (payload {step, data}).
// Steps: extension, client_approval, submitted, submission_result, amendment_opened,
// notice_case, rollforward, manual_step.

import type { FilingStatusDto, SubmissionDto } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';

export function filingState(wp: Workpaper): FilingStatusDto {
  let extension: FilingStatusDto['extension'] = null;
  let approval: (Omit<NonNullable<FilingStatusDto['clientApproval']>, 'current'>) | null = null;
  let approvalSeq = 0;
  const subs = new Map<string, SubmissionDto>();
  const amendments: FilingStatusDto['amendments'] = [];
  const noticeCases: FilingStatusDto['noticeCases'] = [];
  for (const s of wp.state.filingSteps) {
    const d = (s.data ?? {}) as any;
    switch (s.step) {
      case 'extension':
        extension = { federal: d.federal, california: d.california, by: s.by, at: s.at };
        break;
      case 'client_approval':
        approval = { by: s.by, at: s.at, pins: d.pinsMasked ?? {}, returnHash: d.returnHash };
        approvalSeq = s.seq;
        break;
      case 'submitted':
        for (const x of d.submissions ?? [])
          subs.set(x.id, { id: x.id, jurisdiction: x.jurisdiction, snapshotId: d.snapshotId, contentHash: d.contentHash, submittedBy: s.by, submittedAt: s.at, status: 'pending' });
        break;
      case 'submission_result': {
        const sub = subs.get(d.submissionId);
        if (sub) Object.assign(sub, { status: d.status, errors: d.errors ?? [], agencySubmissionId: d.agencySubmissionId, resultAt: s.at });
        break;
      }
      case 'amendment_opened':
        amendments.push({ id: d.amendmentId, baseSnapshotId: d.baseSnapshotId, baseSeq: d.baseSeq, reason: d.reason, by: s.by, at: s.at });
        break;
      case 'notice_case':
        noticeCases.push({ caseId: d.caseId, noticeId: d.noticeId, snapshotId: d.snapshotId, contentHash: d.contentHash, by: s.by, at: s.at });
        break;
    }
  }
  const submissions = [...subs.values()];
  const accepted = (j: string) => submissions.some((x) => x.jurisdiction === j && x.status === 'accepted');
  return {
    extension,
    // Current only while the return is unchanged AND the partner's sign-off still stands (D-48).
    clientApproval: approval ? { ...approval, current: wp.scopeHashMatches('return', approval.returnHash, approvalSeq) && partnerSignedReturn(wp) } : null,
    approvalOpen: partnerSignedReturn(wp)
      ? { open: true }
      : { open: false, reason: "Your preparer's partner hasn't signed off the return yet. You can approve it once they have." },
    submissions,
    snapshots: wp.store.snapshots(),
    amendments,
    noticeCases,
    filed: accepted('federal') && accepted('california'),
    frozen: returnFrozen(wp.state.filingSteps),
  };
}

/**
 * Freeze after filing: once an agency has accepted the return, value-changing work is refused
 * until an amendment is opened (design §5.6 amendment layer). A rejection doesn't freeze it.
 */
export function returnFrozen(steps: { step: string; data?: unknown; seq: number }[]): boolean {
  let accepted = 0;
  let amended = 0;
  for (const s of steps) {
    const d = (s.data ?? {}) as any;
    if (s.step === 'submission_result' && d.status === 'accepted') accepted = s.seq;
    if (s.step === 'amendment_opened') amended = s.seq;
  }
  return accepted > 0 && amended < accepted;
}

export const FROZEN_MESSAGE = 'The return is filed. Open an amendment to change it.';

/** True while a partner sign-off on the whole return is valid (not reopened or withdrawn). */
export function partnerSignedReturn(wp: Workpaper): boolean {
  return [...wp.state.signoffs.values()].some((s) => s.scope === 'return' && s.level === 'partner' && s.status === 'valid');
}

/** The snapshot that is "the filed return": the latest one behind an accepted federal submission, else the latest filing snapshot. */
export function filedSnapshotId(wp: Workpaper): string | undefined {
  const st = filingState(wp);
  const acc = st.submissions.filter((s) => s.jurisdiction === 'federal' && s.status === 'accepted').at(-1);
  if (acc) return acc.snapshotId;
  return st.snapshots.filter((s) => s.kind === 'filing').at(-1)?.id;
}
