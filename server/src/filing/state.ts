// Filing lifecycle as a projection of `filing.step` events (payload {step, data}).
// Steps: extension, client_approval, submitted, submission_result, amendment_opened,
// notice_case, rollforward, manual_step.

import type { FilingStatusDto, SubmissionDto } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';

export function filingState(wp: Workpaper): FilingStatusDto {
  let extension: FilingStatusDto['extension'] = null;
  let approval: (Omit<NonNullable<FilingStatusDto['clientApproval']>, 'current'>) | null = null;
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
    clientApproval: approval ? { ...approval, current: approval.returnHash === wp.scopeHash('return') && partnerSignedReturn(wp) } : null,
    approvalOpen: partnerSignedReturn(wp)
      ? { open: true }
      : { open: false, reason: "Your preparer's partner hasn't signed off the return yet. You can approve it once they have." },
    submissions,
    snapshots: wp.store.snapshots(),
    amendments,
    noticeCases,
    filed: accepted('federal') && accepted('california'),
  };
}

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
