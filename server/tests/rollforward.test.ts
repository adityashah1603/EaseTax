import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { nodeKind } from '@easetax/shared';
import type { RollProvenance, RollforwardDocument } from '@easetax/shared';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';
import { ViewCtx } from '../src/views/ctx.ts';
import { variances } from '../src/views/summary.ts';
import { carryoverAgreement } from '../src/views/carryovers.ts';
import { openAmendment, recordClientApproval, recordResult, submit } from '../src/filing/commands.ts';
import { loadSnapshot } from '../src/filing/snapshot.ts';
import { buildRollForward, rollForward } from '../src/filing/rollforward.ts';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));
let wp: Workpaper;
const A = (id: string) => wp.actor(id);
beforeEach(() => {
  wp = new Workpaper(baseline, new EventStore(':memory:'));
});

/** A source id resolves when it is a graph node, a prior-years pointer that exists, an extracted value, an issue, a judgment, a note or a question. */
function resolves(id: string): boolean {
  if (wp.g.nodes.has(id)) return true;
  if (id.startsWith('py:')) return wp.b.pointer('py', id.slice(3)) !== undefined;
  if (id.startsWith('agency:')) return wp.b.pointer('agency', id.slice(7)) !== undefined;
  if (id.startsWith('qa:')) return wp.b.qa.has(id.slice(3));
  if (id.startsWith('ref:')) return wp.rawValue(id) !== undefined;
  if (id.startsWith('ev:')) return wp.b.evs.has(id.slice(3));
  if (id.startsWith('household:')) return !!wp.person(id.slice(10));
  if (id.startsWith('note:')) return wp.state.notes.has(id.slice(5));
  if (id.startsWith('question:')) return wp.state.questions.has(id.slice(9));
  if (wp.issues().some((i) => i.id === id)) return true;
  return wp.state.judgments.has(id);
}

function expectTraced(item: RollProvenance, what: string) {
  expect(item.sources.length, what).toBeGreaterThan(0);
  for (const s of item.sources) expect(resolves(s), `${what}: ${s}`).toBe(true);
  // The primary source opens in the trace drawer (GET /api/nodes/:id accepts it).
  expect(item.primary, what).toBeDefined();
  expect(() => wp.assertNode(item.primary!)).not.toThrow();
  for (const h of item.history) if (h.nodeId) expect(resolves(h.nodeId), `${what} history ${h.nodeId}`).toBe(true);
}

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
  // D-65: errors closed by hand need a second person to confirm.
  const waiting = wp.issues().filter((i) => i.awaitingConfirmation).map((i) => i.id);
  if (waiting.length) wp.commit(A('st-02'), waiting.map((issueId) => ({ type: 'issue.closure_confirmed' as const, payload: { issueId } })));
  wp.signoff(A('st-02'), 'return', 'reviewer');
  wp.signoff(A('st-03'), 'return', 'partner');
  recordClientApproval(wp, A('cu-01'), { pins: { taxpayer: '41207', spouse: '88310' }, consent: true });
}

describe('roll-forward traces every item back to 2025', () => {
  it('carryovers carry sources that resolve, and a 2024 → 2025 → 2026 history', () => {
    const d: RollforwardDocument = buildRollForward(wp, { toYear: 2026 });
    expect(d.carryovers.length).toBeGreaterThan(10);
    for (const c of d.carryovers) expectTraced(c, `carryover ${c.key}`);

    const st = d.carryovers.find((c) => c.key === 'capital_loss_short')!;
    expect(st.sources).toEqual(expect.arrayContaining(['line:v3:SchD.6', 'line:v3:SchD.7', 'line:v3:SchD.16', 'py:/carryovers_into_2025/capital_loss_short']));
    expect(st.history.map((h) => h.year)).toEqual([2024, 2025, 2026]);
    expect(st.history[0]).toMatchObject({ value: 3200, nodeId: 'py:/carryovers_into_2025/capital_loss_short' });
    expect(st.history.at(-1)!.value).toBe(0);

    const scorp = d.carryovers.find((c) => c.key === 'scorp_stock_basis_end')!;
    expect(scorp.sources).toEqual(expect.arrayContaining(['line:v3:F7203.15', 'line:v3:F7203.1', 'py:/basis_records/scorp_lindqvist_family_woodworks/0']));
    expect(scorp.history.find((h) => h.year === 2022)!.value).toBe(21300);

    const mtc = d.carryovers.find((c) => c.key === 'minimum_tax_credit_from_2025_amt')!;
    expect(mtc.amount).toBe(3871);
    expect(mtc.sources).toEqual(expect.arrayContaining(['line:v3:F6251.11', 'diag:v3:AMT_CREDIT_CARRYFORWARD']));

    const appl = d.carryovers.find((c) => c.key === 'depreciation_basis_differences.SAC-APPL')!;
    expect(appl.sources).toEqual(expect.arrayContaining(['asset:v3:SAC-APPL', 'py:/asset_records/1']));
    expect(appl.history[0]!.value).toBeCloseTo(725.76, 2); // 4,200 federal bonus less 3,474.24 California through 2024
  });

  it('basis figures trace to Form 7203 / 8606 lines and the prior-year basis records', () => {
    const d = buildRollForward(wp);
    for (const b of d.basis) expectTraced(b, `basis ${b.what}`);
    const s = d.basis.find((b) => /S corporation/.test(b.what))!;
    expect(s.sources).toEqual(expect.arrayContaining(['line:v3:F7203.15', 'py:/basis_records/scorp_lindqvist_family_woodworks/2']));
    const home = d.basis.find((b) => /Home/.test(b.what))!;
    expect(home.sources).toEqual(expect.arrayContaining(['py:/basis_records/home_7709_barton_ridge/0', 'doc:D54']));
  });

  it('asset rows link to their asset nodes and the prior-year register', () => {
    const d = buildRollForward(wp);
    for (const a of [...d.assets, ...d.disposedAssets]) {
      expectTraced(a, `asset ${a.assetId}`);
      expect(a.primary).toBe(`asset:v3:${a.assetId}`);
      expect(wp.g.nodes.has(a.from)).toBe(true);
    }
    const bldg = d.assets.find((a) => a.assetId === 'SAC-BLDG')!;
    expect(bldg.sources).toContain('py:/asset_records/0');
    expect(bldg.history[0]).toMatchObject({ year: 2024, nodeId: 'py:/asset_records/0' });
    expect(bldg.history[0]!.value).toBeCloseTo(72248.47, 2);
    expect(bldg.history.at(-1)).toMatchObject({ year: 2026, value: 85484.83 });
    const camera = d.assets.find((a) => a.assetId === 'STU-CAMERA')!;
    expect(camera.sources).toContain('line:v3:FTB3885A.STU-CAMERA');
    expect(d.disposedAssets.map((a) => a.assetId)).toContain('AUS-BLDG');
  });

  it('open items link to their issues, notes and judgments; prior-preparer items carry over', () => {
    wp.commit(A('st-02'), [{ type: 'note.created', payload: { noteId: 'n-basis', nodeIds: ['line:v3:F7203.1'], text: 'Get the 2023 K-1 next year', blocking: false } }]);
    wp.commit(A('st-01'), [{ type: 'judgment.recorded', payload: { judgmentId: 'j-home', kind: 'election', topic: 'Home office method', decision: 'Simplified method', alternatives: ['Actual expenses'], authority: 'Rev. Proc. 2013-13', nodeIds: ['line:v3:SchC.30'] } }]);
    const d = buildRollForward(wp);
    for (const o of d.openItems) expectTraced(o, `open item ${o.kind} ${o.id}`);

    const openIssues = wp.issues().filter((i) => i.status === 'open' && i.severity !== 'info');
    expect(openIssues.length).toBeGreaterThan(0);
    for (const i of openIssues) {
      const item = d.openItems.find((o) => o.kind === 'issue' && o.id === i.id)!;
      expect(item, i.id).toBeDefined();
      expect(item.sources[0]).toBe(i.id);
      expect(item.sources).toEqual(expect.arrayContaining(i.nodeIds));
    }
    const note = d.openItems.find((o) => o.kind === 'note')!;
    expect(note.sources).toEqual(['note:n-basis', 'line:v3:F7203.1']);
    expect(d.openItems.find((o) => o.kind === 'judgment' && o.id === 'j-home')!.sources).toContain('j-home');

    const pp = d.openItems.filter((o) => o.kind === 'prior_preparer');
    expect(pp).toHaveLength(4);
    const k1 = pp.find((o) => /Woodworks K-1/.test(o.text))!;
    expect(k1.sources).toEqual(expect.arrayContaining(['py:/prior_preparer_workpaper/open_items_left_by_prior_preparer/0', 'line:v3:F7203.1']));
    // The note on F7203.1 is part of that item's 2025 history.
    expect(k1.changes.map((c) => c.id)).toContain('n-basis');
  });

  it('records the 2025 events that changed an item (adjustments)', () => {
    wp.proposeAdjustment(A('st-03'), 'line:v3:F7203.1', 5000, 'Basis per reconstructed 2023 K-1');
    const d = buildRollForward(wp);
    const s = d.basis.find((b) => /S corporation/.test(b.what))!;
    const adj = s.changes.find((c) => c.kind === 'adjustment')!;
    expect(adj).toMatchObject({ nodeId: 'line:v3:F7203.1' });
    expect(adj.summary).toMatch(/2,300 → 5,000: Basis per reconstructed/);
  });

  it('planning items rest on the lines and prior-year tax they come from', () => {
    const d = buildRollForward(wp);
    for (const p of d.planning.items.filter((x) => x.amount !== undefined)) expectTraced(p, `planning ${p.key}`);
    const fed = d.planning.items.find((p) => p.key === 'federal.required_annual_payment')!;
    expect(fed.amount).toBe(Math.round(81962 * 1.1));
    expect(fed.sources).toEqual(expect.arrayContaining(['line:v3:F1040.24', 'py:/return_2024/lines/F1040.24']));
    expect(fed.history.map((h) => h.value)).toEqual([37557, 81962, fed.amount]);
    for (const p of d.planning.items) for (const s of p.sources) expect(resolves(s), `${p.key}: ${s}`).toBe(true);
  });

  it('says it was built from the live workpaper before filing', () => {
    const r = rollForward(wp, A('st-01'), { toYear: 2026 });
    expect(r.data.document.builtFrom).toMatchObject({ kind: 'live_workpaper' });
    expect(r.data.document.sourceSnapshot).toBeNull();
    expect(loadSnapshot<RollforwardDocument>(wp, r.data.id).content.builtFrom.kind).toBe('live_workpaper');
  });

  it('builds from the filed snapshot once filed (D-28), and an adjustment after filing does not leak in', () => {
    makeReady();
    const { snapshot: snap, submissions } = submit(wp, A('st-02')).data;
    for (const s of submissions) recordResult(wp, A('st-02'), s.id, { status: 'accepted', agencySubmissionId: `X-${s.id}` });
    // Filed and accepted: the return is frozen until an amendment opens.
    openAmendment(wp, A('st-03'), { reason: 'After filing' });
    wp.proposeAdjustment(A('st-03'), 'line:v3:F1040.24', 1, 'After filing');
    const d = rollForward(wp, A('st-01')).data.document;
    expect(d.builtFrom).toMatchObject({ kind: 'filed_snapshot', snapshotId: snap.id });
    expect(d.sourceSnapshot!.id).toBe(snap.id);
    expect(d.planning.federal.priorYearTax.amount).toBe(81962);
    const fed = d.planning.items.find((p) => p.key === 'federal.required_annual_payment')!;
    expect(fed.changes.some((c) => c.kind === 'adjustment')).toBe(false);
    for (const c of d.carryovers) expectTraced(c, `carryover ${c.key}`);
  });
});
