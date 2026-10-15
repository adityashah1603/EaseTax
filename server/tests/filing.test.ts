import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';
import { ViewCtx } from '../src/views/ctx.ts';
import { variances } from '../src/views/summary.ts';
import { carryoverAgreement } from '../src/views/carryovers.ts';
import { readiness } from '../src/filing/readiness.ts';
import { filingState } from '../src/filing/state.ts';
import { amendmentDiff, openAmendment, recordClientApproval, recordExtension, recordResult, submit } from '../src/filing/commands.ts';
import { canonicalJson, freezeContent, loadSnapshot, sha256 } from '../src/filing/snapshot.ts';
import { buildNoticeCase, exportNoticeCase } from '../src/filing/notice.ts';
import { rollForward } from '../src/filing/rollforward.ts';
import { registerRoutes } from '../src/api/routes.ts';
import { registerFilingRoutes } from '../src/api/filing.ts';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));
let wp: Workpaper;
const A = (id: string) => wp.actor(id);
beforeEach(() => {
  wp = new Workpaper(baseline, new EventStore(':memory:'));
});

/** Do the minimum work a clean readiness needs. Preparer st-01 prepares; st-02/st-03 review. */
function makeReady() {
  const prep = A('st-01');
  for (const d of wp.documents()) if (!d.disposition) wp.commit(prep, [{ type: 'disposition.set', payload: { documentId: d.id, status: d.linesFed ? 'used' : 'not_relevant', note: 'reviewed' } }]);
  const ctx = new ViewCtx(wp);
  for (const v of variances(ctx)) if (v.flagged && !v.explanation) wp.commit(prep, [{ type: 'variance.explained', payload: { nodeId: v.nodeId, explanation: 'explained' } }]);
  wp.verify(prep, carryoverAgreement(ctx).map((r) => r.nodeId), 'agreed_to_prior_year');
  wp.verify(prep, ['household:theo'], 'agreed_to_source_document', 'SS card D71');
  for (const j of ['federal', 'california'])
    wp.commit(prep, [{ type: 'reconciliation.explained', payload: { reconciliationId: `payments:${j}`, explanation: 'agreed to agency record; adjustment proposed', status: 'explained' } }]);
  wp.commit(prep, [{ type: 'judgment.recorded', payload: { judgmentId: 'dd1', kind: 'due_diligence', topic: 'Form 8867 CTC/ODC', decision: 'Completed', alternatives: [], authority: 'IRC 6695(g)', nodeIds: ['line:v3:F8867.status'] } }]);
  const open = wp.issues().filter((i) => i.status === 'open' && i.severity !== 'info').map((i) => i.id);
  if (open.length) wp.commit(prep, open.map((issueId) => ({ type: 'issue.resolved' as const, payload: { issueId, status: 'accepted' as const, resolution: 'reviewed' } })));
  wp.signoff(A('st-02'), 'return', 'reviewer');
  wp.signoff(A('st-03'), 'return', 'partner');
  recordClientApproval(wp, A('cu-01'), { pins: { taxpayer: '41207', spouse: '88310' }, consent: true });
}

describe('readiness', () => {
  it('starts blocked with a reason per required step', () => {
    const r = readiness(wp);
    expect(r.ready).toBe(false);
    expect(r.steps.map((s) => s.step)).toEqual(baseline.packet.firm.starter_standards.required_steps);
    const pay = r.steps.find((s) => /Estimated payments/.test(s.step))!;
    expect(pay.ok).toBe(false);
    expect(pay.reason).toContain('13,000');
    expect(r.steps.find((s) => /Engagement/.test(s.step))!.ok).toBe(true);
  });

  it('becomes clean once the work is done', () => {
    makeReady();
    const r = readiness(wp);
    expect(r.steps.filter((s) => !s.ok)).toEqual([]);
    expect(r.ready).toBe(true);
  });

  it('blocks on an open blocking review note, and submit refuses', () => {
    makeReady();
    wp.commit(A('st-02'), [{ type: 'note.created', payload: { noteId: 'n1', nodeIds: ['line:v3:SchA.12'], text: 'Support the car value', blocking: true } }]);
    const r = readiness(wp);
    expect(r.ready).toBe(false);
    expect(r.blockers[0]).toMatchObject({ code: 'BLOCKING_NOTE', nodeIds: ['line:v3:SchA.12'] });
    expect(() => submit(wp, A('st-02'))).toThrow(/Not ready to file/);
    wp.commit(A('st-02'), [{ type: 'note.resolved', payload: { noteId: 'n1' } }]);
    expect(readiness(wp).ready).toBe(true);
  });

  it('a change after client approval requires renewed approval', () => {
    makeReady();
    wp.proposeAdjustment(A('st-03'), 'line:v3:SchB.1.2', 0, 'Duplicate of composite interest');
    const step = readiness(wp).steps.find((s) => /Client approval/.test(s.step))!;
    expect(step.ok).toBe(false);
    expect(step.reason).toMatch(/changed after the client approved/);
  });
});

describe('client approval', () => {
  it('is client-only and never echoes or stores the PINs', () => {
    expect(() => recordClientApproval(wp, A('st-02'), { pins: { taxpayer: '41207' }, consent: true })).toThrow(/cannot approve the return for the client/);
    const r = recordClientApproval(wp, A('cu-01'), { pins: { taxpayer: '41207', spouse: '88310' }, consent: true });
    expect(JSON.stringify(r.data)).not.toMatch(/41207|88310/);
    expect(JSON.stringify(wp.store.all())).not.toMatch(/41207|88310/);
    expect(filingState(wp).clientApproval).toMatchObject({ by: 'cu-01', current: true, pins: { taxpayer: '•••••', spouse: '•••••' } });
  });
});

describe('submit, freeze and after', () => {
  it('freezes a snapshot whose hash is stable and verifiable', () => {
    makeReady();
    const expected = sha256(canonicalJson(freezeContent(wp)));
    expect(sha256(canonicalJson(freezeContent(wp)))).toBe(expected);
    const seqBefore = wp.state.seq;
    const r = submit(wp, A('st-02'));
    expect(r.data.snapshot.contentHash).toBe(expected);
    expect(r.data.snapshot.seq).toBe(seqBefore);
    const loaded = loadSnapshot(wp, r.data.snapshot.id);
    expect(loaded.contentHash).toBe(expected);
    expect(loaded.content.lines.find((l) => l.key === 'F1040.24')!.value).toBe(81962);
    expect(loaded.content.state.signoffs.length).toBe(2);
    // Later work does not touch the frozen content.
    wp.proposeAdjustment(A('st-03'), 'line:v3:SchB.1.2', 0, 'Duplicate');
    expect(loadSnapshot(wp, r.data.snapshot.id).contentHash).toBe(expected);
    expect(r.data.submissions.map((s) => s.id)).toEqual(['S1-federal', 'S2-california']);
    expect(() => submit(wp, A('st-02'))).toThrow();
  });

  it('only reviewer/partner may submit; preparer cannot', () => {
    makeReady();
    expect(() => submit(wp, A('st-01'))).toThrow(/cannot file, extend or record e-file results/);
  });

  it('replays the e-file rejection, resubmission and acceptance from the packet', () => {
    recordExtension(wp, A('st-02'), {});
    expect(filingState(wp).extension).toMatchObject({ federal: 36000, california: 0 });
    makeReady();
    submit(wp, A('st-02'));
    recordResult(wp, A('st-02'), 'S1-federal', { replay: true });
    recordResult(wp, A('st-02'), 'S2-california', { replay: true });
    let st = filingState(wp);
    expect(st.submissions[0]).toMatchObject({ status: 'rejected', errors: [{ code: 'R0000-504-02' }] });
    expect(st.submissions[1]!.status).toBe('not_transmitted');
    const again = submit(wp, A('st-02'));
    expect(again.data.submissions.map((s) => s.id)).toEqual(['S3-federal', 'S4-california']);
    recordResult(wp, A('st-02'), 'S3-federal', { replay: true });
    recordResult(wp, A('st-02'), 'S4-california', { replay: true });
    st = filingState(wp);
    expect(st.filed).toBe(true);
    expect(st.submissions[2]!.agencySubmissionId).toBe('71530420261950019871');
  });

  it('records an amendment layer diffed against the frozen snapshot', () => {
    makeReady();
    const snap = submit(wp, A('st-02')).data.snapshot;
    wp.proposeAdjustment(A('st-03'), 'line:v3:SchB.1.2', 0, 'Duplicate of Northlake composite interest');
    const r = openAmendment(wp, A('st-03'), { reason: 'Duplicate interest found after filing' });
    expect(r.data.base.snapshotId).toBe(snap.id);
    const d = amendmentDiff(wp, r.data.amendmentId);
    expect(d.diffs).toEqual([expect.objectContaining({ key: 'SchB.1.2', filed: 1840, current: 0, change: 'changed' })]);
    expect(d.changesSinceFiling.length).toBe(1);
  });

  it('builds the Letter 566 bundle from the frozen snapshot with the full trace', () => {
    makeReady();
    wp.verify(A('st-01'), ['ev:ev-1054'], 'agreed_to_source_document', '1098-C box 4c');
    const snap = submit(wp, A('st-02')).data.snapshot;
    // A post-filing change must not leak into the notice bundle.
    wp.proposeAdjustment(A('st-03'), 'line:v3:F8283.A1.vehicle', 2900, 'Limited to 1098-C gross proceeds');
    const r = buildNoticeCase(wp, A('st-02'), 'N-2025-L566');
    const b = r.data.bundle;
    expect(b.filedReturn.snapshotId).toBe(snap.id);
    const [schA, schC] = b.items;
    expect(schA!.lines.map((l) => l!.key)).toEqual(['SchA.12']);
    expect(schA!.lines[0]!.value).toBe(20500);
    const tA = JSON.stringify(schA!.traces);
    for (const id of ['line:v3:F8283.A1.vehicle', 'line:v3:F8283.A1.stock', 'ev:ev-1055', 'doc:D66', 'qa:qa-39', 'doc:D65#page1']) expect(tA).toContain(id);
    expect(tA).toContain('"value":6000');
    expect(schA!.documents.map((d) => d.id)).toEqual(expect.arrayContaining(['D65', 'D66']));
    expect(schA!.workpaper.verifications.map((v: any) => v.nodeId)).toContain('ev:ev-1054');
    expect(schA!.workpaper.adjustments).toEqual([]);
    expect(schC!.lines.map((l) => l!.key)).toEqual(['SchC.1']);
    const tC = JSON.stringify(schC!.traces);
    for (const id of ['line:v3:SchC.1', 'ev:ev-0127', 'doc:D21', 'ev:ev-0103', 'doc:D14']) expect(tC).toContain(id);
    expect(schC!.reconciliation).toMatchObject({ forms1099NEC: 142000, form1099K: 12400, filedGrossReceipts: 163700 });
    expect(b.signoffs.map((s: any) => s.level)).toEqual(expect.arrayContaining(['reviewer', 'partner']));
    const html = exportNoticeCase(wp, r.data.caseId, 'html').body;
    expect(html).toContain('Schedule A line 12');
    expect(html).toContain(snap.contentHash);
    expect(html).not.toContain('666-41-2287');
    const json = JSON.parse(exportNoticeCase(wp, r.data.caseId, 'json').body);
    expect(json.contentHash).toBe(r.data.contentHash);
  });

  it('refuses a notice case before anything is filed', () => {
    expect(() => buildNoticeCase(wp, A('st-02'), 'N-2025-L566')).toThrow(/not been filed/);
  });

  it('rolls forward to 2026 with carryovers, basis, assets, open items and planning', () => {
    const r = rollForward(wp, A('st-01'), { toYear: 2026 });
    const d = r.data.document;
    expect(d.carryovers.find((c) => c.key === 'minimum_tax_credit_from_2025_amt')!.amount).toBe(3871);
    expect(d.assets.map((a) => a.assetId)).not.toContain('AUS-BLDG');
    expect(d.assets.find((a) => a.assetId === 'STU-PRINTER')!.from).toBe('asset:v3:STU-PRINTER');
    expect(d.basis.some((b: any) => b && /S corporation/.test(b.what))).toBe(true);
    expect(d.planning.federal.requiredAnnualPayment).toBe(Math.round(81962 * 1.1));
    expect(d.planning.federal.installments).toHaveLength(4);
    expect(d.planning.california.installments.map((i) => i.due)).toEqual(['2026-04-15', '2026-06-15', '2027-01-15']);
    expect(d.openItems.length).toBeGreaterThan(0);
    expect(loadSnapshot(wp, r.data.id).contentHash).toBe(r.data.contentHash);
  });
});

describe('filing API', () => {
  it('serves readiness and refuses submit over HTTP when blocked', async () => {
    const app = Fastify();
    registerRoutes(app, wp);
    registerFilingRoutes(app, wp);
    const r = await app.inject({ method: 'GET', url: '/api/filing/readiness', headers: { 'x-actor': 'st-02' } });
    expect(r.json().ready).toBe(false);
    const s = await app.inject({ method: 'POST', url: '/api/filing/submit', headers: { 'x-actor': 'st-02' } });
    expect(s.statusCode).toBe(422);
    const ap = await app.inject({ method: 'POST', url: '/api/filing/client-approval', headers: { 'x-actor': 'cu-02' }, payload: { pins: { spouse: '88310' }, consent: true } });
    expect(ap.statusCode).toBe(200);
    expect(ap.body).not.toContain('88310');
  });
});
