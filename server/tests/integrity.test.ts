import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { areaOfKey } from '../src/baseline/areas.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';
import { RULES } from '../src/policy/policy.ts';
import { effectMagnitude } from '@easetax/shared';
import { ViewCtx } from '../src/views/ctx.ts';
import { variances } from '../src/views/summary.ts';
import { carryoverAgreement } from '../src/views/carryovers.ts';
import { filingState } from '../src/filing/state.ts';
import { openAmendment, recordClientApproval, recordResult, submit } from '../src/filing/commands.ts';
import { buildNoticeCase } from '../src/filing/notice.ts';
import { rollForward } from '../src/filing/rollforward.ts';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));
let wp: Workpaper;
const A = (id: string) => wp.actor(id);
const INVEST = 'area:investments_and_digital_assets';
const signoffs = () => [...wp.state.signoffs.values()];
const FROZEN = 'The return is filed. Open an amendment to change it.';

beforeEach(() => {
  wp = new Workpaper(baseline, new EventStore(':memory:'));
});

/** Same minimum work as filing.test's helper. Preparer st-01 prepares; st-02/st-03 review. */
function makeReady() {
  const prep = A('st-01');
  for (const d of wp.documents()) if (!d.disposition) wp.commit(prep, [{ type: 'disposition.set', payload: { documentId: d.id, status: d.linesFed ? 'used' : 'not_relevant', note: 'reviewed' } }]);
  const ctx = new ViewCtx(wp);
  for (const v of variances(ctx)) if (v.flagged && !v.explanation) wp.commit(prep, [{ type: 'variance.explained', payload: { nodeId: v.nodeId, explanation: 'explained' } }]);
  wp.verify(prep, carryoverAgreement(ctx).map((r) => r.nodeId), 'agreed_to_prior_year');
  wp.verify(prep, ['household:theo'], 'agreed_to_source_document', 'SS card D71');
  for (const j of ['federal', 'california'])
    wp.commit(prep, [{ type: 'reconciliation.explained', payload: { reconciliationId: `payments:${j}`, explanation: 'agreed to agency record', status: 'explained' } }]);
  wp.commit(prep, [{ type: 'judgment.recorded', payload: { judgmentId: 'dd1', kind: 'due_diligence', topic: 'Form 8867 CTC/ODC', decision: 'Completed', alternatives: [], authority: 'IRC 6695(g)', nodeIds: ['line:v3:F8867.status'] } }]);
  const open = wp.issues().filter((i) => i.status === 'open' && i.severity !== 'info').map((i) => i.id);
  if (open.length) wp.commit(prep, open.map((issueId) => ({ type: 'issue.resolved' as const, payload: { issueId, status: 'accepted' as const, resolution: 'reviewed' } })));
  const waiting = wp.issues().filter((i) => i.awaitingConfirmation).map((i) => i.id);
  if (waiting.length) wp.commit(A('st-02'), waiting.map((issueId) => ({ type: 'issue.closure_confirmed' as const, payload: { issueId } })));
  wp.signoff(A('st-02'), 'return', 'reviewer');
  wp.signoff(A('st-03'), 'return', 'partner');
  recordClientApproval(wp, A('cu-01'), { pins: { taxpayer: '41207', spouse: '88310' }, consent: true });
}

function file() {
  makeReady();
  const { submissions } = submit(wp, A('st-02')).data;
  for (const s of submissions) recordResult(wp, A('st-02'), s.id, { status: 'accepted', agencySubmissionId: `X-${s.id}` });
}

describe('undo cannot leave a sign-off valid over changed content (scope hash)', () => {
  it('undoing an adjustment made before the sign-off reopens it, with a reason', () => {
    const [adj] = wp.proposeAdjustment(A('st-01'), 'line:v3:SchB.1.2', 0, 'Duplicate interest');
    wp.signoff(A('st-02'), INVEST, 'reviewer');
    expect(signoffs()[0]!.status).toBe('valid');
    const [undo] = wp.undo(A('st-01'), { eventId: adj!.id });
    const so = signoffs()[0]!;
    expect(so.status).toBe('reopened');
    expect(so.reopenedReason).toMatch(/content changed since sign-off \(undo\)/i);
    expect(so.reopenedBySeq).toBe(undo!.seq);
    expect(so.changedNodeIds).toEqual(['line:v3:SchB.1.2']);
    // And it stays reopened when the server restarts from the log.
    const again = new Workpaper(baseline, wp.store);
    expect([...again.state.signoffs.values()][0]!.status).toBe('reopened');
  });

  it('a sign-off stays valid across a restart when nothing changed', () => {
    wp.proposeAdjustment(A('st-01'), 'line:v3:SchB.1.2', 0, 'Duplicate interest');
    wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829156', 'D62 prints 74-3829156');
    wp.verify(A('st-01'), ['line:v3:SchB.1.2'], 'recalculated');
    wp.signoff(A('st-02'), 'return', 'reviewer');
    const again = new Workpaper(baseline, wp.store);
    expect([...again.state.signoffs.values()][0]!.status).toBe('valid');
    // Unrelated undo: the rebuild re-checks and keeps it valid.
    const [n] = wp.commit(A('st-01'), [{ type: 'time.logged', payload: { area: 'investments_and_digital_assets', hours: 1 } }]);
    wp.undo(A('st-01'), { eventId: n!.id });
    expect(signoffs()[0]!.status).toBe('valid');
  });

  it('undoing a read correction made before the sign-off reopens it', () => {
    const [c] = wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829156', 'D62 prints 74-3829156');
    wp.signoff(A('st-02'), 'return', 'reviewer');
    wp.undo(A('st-01'), { eventId: c!.id });
    expect(signoffs()[0]).toMatchObject({ status: 'reopened', changedNodeIds: ['ev:ev-1045'] });
  });

  it('the normal reopen flow still works, and undoing the later change restores what was signed', () => {
    wp.signoff(A('st-02'), INVEST, 'reviewer');
    const [adj] = wp.proposeAdjustment(A('st-01'), 'line:v3:SchB.1.2', 0, 'Duplicate interest');
    expect(signoffs()[0]).toMatchObject({ status: 'reopened', changedNodeIds: ['line:v3:SchB.1.2'] });
    expect(signoffs()[0]!.reopenedReason).toBeUndefined();
    wp.undo(A('st-01'), { eventId: adj!.id });
    expect(signoffs()[0]!.status).toBe('valid');
  });

  it('removing or undoing a verification made before the sign-off reopens it', () => {
    const [v] = wp.verify(A('st-01'), ['line:v3:SchB.1.2'], 'recalculated');
    wp.signoff(A('st-02'), INVEST, 'reviewer');
    wp.commit(A('st-01'), [{ type: 'verification.removed', payload: { verificationId: (v!.payload as any).verificationId } }]);
    expect(signoffs()[0]).toMatchObject({ status: 'reopened', reopenedReason: expect.stringMatching(/verification/) });

    wp = new Workpaper(baseline, new EventStore(':memory:'));
    const [v2] = wp.verify(A('st-01'), ['line:v3:SchB.1.2'], 'recalculated');
    wp.signoff(A('st-02'), INVEST, 'reviewer');
    wp.undo(A('st-01'), { eventId: v2!.id });
    expect(signoffs()[0]!.status).toBe('reopened');
  });

  it('a verification added and removed after the sign-off leaves it valid', () => {
    wp.signoff(A('st-02'), INVEST, 'reviewer');
    const [v] = wp.verify(A('st-01'), ['line:v3:SchB.1.2'], 'recalculated');
    expect(signoffs()[0]!.status).toBe('valid');
    wp.commit(A('st-01'), [{ type: 'verification.removed', payload: { verificationId: (v!.payload as any).verificationId } }]);
    expect(signoffs()[0]!.status).toBe('valid');
    expect([...new Workpaper(baseline, wp.store).state.signoffs.values()][0]!.status).toBe('valid');
  });

  it('a verification outside an area does not touch its sign-off', () => {
    const outside = wp.lines({}).find((l) => !wp.state.inScope(INVEST, [l.id]))!.id;
    const [v] = wp.verify(A('st-01'), [outside], 'agreed_to_source_document');
    wp.signoff(A('st-02'), INVEST, 'reviewer');
    wp.undo(A('st-01'), { eventId: v!.id });
    expect(signoffs()[0]!.status).toBe('valid');
  });
});

describe('the partner threshold cannot be dodged by splitting (D-20)', () => {
  it('measures each adjustment against the engine value', () => {
    // SchC.1 is 163,700; each 1,500 step is under the threshold on its own.
    wp.proposeAdjustment(A('st-01'), 'line:v3:SchC.1', 162200, 'step 1');
    const first = [...wp.state.adjustments.values()].at(-1)!;
    expect(first).toMatchObject({ status: 'approved', requiresPartner: false });
    let last = first;
    for (const v of [160700, 159200, 157700, 156200, 154700, 153200, 151700]) {
      wp.proposeAdjustment(A('st-01'), 'line:v3:SchC.1', v, `step to ${v}`);
      last = [...wp.state.adjustments.values()].at(-1)!;
      if (last.requiresPartner) break;
    }
    expect(last).toMatchObject({ requiresPartner: true, status: 'proposed' });
    // The displayed effect is still this step's own effect (current value to new), not the total.
    expect(effectMagnitude(last.effect!)).toBeLessThanOrEqual(1000);
    // Not in force until a partner approves it.
    expect(wp.lineValue('SchC.1')).not.toBe(last.newValue);
  });
});

describe('reverting a large adjustment needs a partner (D-20)', () => {
  it('refuses a preparer reverting or undoing a partner-approved adjustment', () => {
    const [p] = wp.proposeAdjustment(A('st-01'), 'line:v3:SchC.1', 151300, '1099-K already inside Atlas receipts');
    const id = (p!.payload as any).adjustmentId;
    wp.decideAdjustment(A('st-03'), id, 'approve');
    expect(() => wp.decideAdjustment(A('st-01'), id, 'revert')).toThrow(/cannot approve adjustments/);
    expect(() => wp.undo(A('st-01'), { eventId: p!.id })).toThrow(/cannot approve adjustments/);
    expect(wp.lineValue('SchC.1')).toBe(151300);
    wp.decideAdjustment(A('st-03'), id, 'revert');
    expect(wp.lineValue('SchC.1')).toBe(163700);
  });

  it("covers a partner's own large adjustment too", () => {
    const [p] = wp.proposeAdjustment(A('st-03'), 'line:v3:SchC.1', 151300, 'Partner adjustment');
    expect(() => wp.decideAdjustment(A('st-02'), (p!.payload as any).adjustmentId, 'revert')).toThrow(/cannot approve adjustments/);
  });

  it('a small adjustment can still be reverted by a preparer', () => {
    const [p] = wp.proposeAdjustment(A('st-01'), 'line:v3:SchB.1.2', 0, 'Duplicate interest');
    wp.decideAdjustment(A('st-04'), (p!.payload as any).adjustmentId, 'revert');
    expect(wp.lineValue('SchB.1.2')).toBe(1840);
  });
});

describe('corrections count as preparation for self-review', () => {
  it('whoever corrected a read cannot review the lines it feeds', () => {
    wp.correctRead(A('st-02'), 'ev:ev-1045', '74-3829156', 'D62 prints 74-3829156');
    const area = `area:${areaOfKey('F2441.1b')}`;
    expect(() => wp.signoff(A('st-02'), area, 'reviewer')).toThrow(RULES.noSelfReview);
    expect(() => wp.signoff(A('st-02'), 'return', 'reviewer')).toThrow(RULES.noSelfReview);
    // An area the corrected value doesn't feed is fine.
    wp.signoff(A('st-02'), INVEST, 'reviewer');
  });

  it('whoever reverted a correction prepared it too', () => {
    const [c] = wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829156', 'D62 prints 74-3829156');
    wp.revertCorrection(A('st-02'), (c!.payload as any).correctionId, 'misread the misread');
    expect(() => wp.signoff(A('st-02'), 'return', 'reviewer')).toThrow(RULES.noSelfReview);
  });

  it('whoever corrected a household record cannot review the return', () => {
    wp.commit(A('st-01'), [{ type: 'question.asked', payload: { questionId: 'q-theo', to: 'client', nodeIds: ['household:theo'], text: "Please confirm Theo's name." } }]);
    wp.commit(A('cu-01'), [{ type: 'question.answered', payload: { questionId: 'q-theo', text: 'Theo Okafor-Lindqvist' } }]);
    wp.correctHousehold(A('st-02'), 'theo', 'name', 'Theo X Okafor-Lindqvist', 'question:q-theo', 'Client confirmed');
    expect(() => wp.signoff(A('st-02'), 'return', 'reviewer')).toThrow(RULES.noSelfReview);
    wp.signoff(A('st-03'), 'return', 'reviewer');
  });
});

describe('freeze after filing', () => {
  it('refuses value-changing work once accepted, until an amendment opens', () => {
    file();
    expect(filingState(wp).frozen).toBe(true);
    const v = [...wp.state.verifications.values()][0]!;
    const attempts: (() => unknown)[] = [
      () => wp.proposeAdjustment(A('st-03'), 'line:v3:SchB.1.2', 0, 'Duplicate'),
      () => wp.correctRead(A('st-01'), 'ev:ev-1045', '74-3829156', 'D62 prints 74-3829156'),
      () => wp.verify(A('st-01'), ['line:v3:SchB.1.2'], 'recalculated'),
      () => wp.commit(A('st-01'), [{ type: 'verification.removed', payload: { verificationId: v.id } }]),
      () => wp.commit(A('st-01'), [{ type: 'disposition.set', payload: { documentId: wp.documents()[0]!.id, status: 'not_relevant', note: 'x' } }]),
      () => wp.signoff(A('st-02'), INVEST, 'reviewer'),
      () => wp.undo(A('st-01'), { eventId: wp.state.events.find((e) => e.type === 'verification.added')!.id }),
    ];
    for (const f of attempts) expect(f).toThrow(FROZEN);

    // Notes, questions, time and seen-marks still go through; so do the notice and roll-forward.
    wp.commit(A('st-02'), [{ type: 'note.created', payload: { noteId: 'n1', nodeIds: ['line:v3:SchA.12'], text: 'For next year', blocking: false } }]);
    wp.commit(A('st-01'), [{ type: 'question.asked', payload: { questionId: 'q1', to: 'client', nodeIds: ['line:v3:SchA.12'], text: 'Any new receipts?' } }]);
    wp.commit(A('st-01'), [{ type: 'time.logged', payload: { area: 'investments_and_digital_assets', hours: 0.5 } }]);
    wp.commit(A('st-01'), [{ type: 'seen.marked', payload: { seq: wp.state.seq } }]);
    expect(buildNoticeCase(wp, A('st-02'), 'N-2025-L566').data.caseId).toBeTruthy();
    expect(rollForward(wp, A('st-01'), { toYear: 2026 }).data.document.builtFrom.kind).toBe('filed_snapshot');

    openAmendment(wp, A('st-02'), { reason: 'Duplicate interest found after filing' });
    expect(filingState(wp).frozen).toBe(false);
    wp.proposeAdjustment(A('st-03'), 'line:v3:SchB.1.2', 0, 'Duplicate');
    expect(wp.lineValue('SchB.1.2')).toBe(0);
  });

  it('a submission still pending or rejected does not freeze the return', () => {
    makeReady();
    const { submissions } = submit(wp, A('st-02')).data;
    expect(filingState(wp).frozen).toBe(false);
    recordResult(wp, A('st-02'), submissions[0]!.id, { status: 'rejected', errors: [{ code: 'X', message: 'bad' }] });
    expect(filingState(wp).frozen).toBe(false);
    wp.proposeAdjustment(A('st-03'), 'line:v3:SchB.1.2', 0, 'Fix before resubmitting');
  });
});
