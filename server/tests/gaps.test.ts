import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';
import { registerRoutes } from '../src/api/routes.ts';
import { pendingJudgments } from '../src/judgments/pending.ts';
import { readiness } from '../src/filing/readiness.ts';
import { confirmRejectionFix, recordRejectionFix, recordResult } from '../src/filing/commands.ts';
import { filingState } from '../src/filing/state.ts';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));
let wp: Workpaper;
const A = (id: string) => wp.actor(id);

beforeEach(() => {
  wp = new Workpaper(baseline, new EventStore(':memory:'));
});

describe('line rows carry revisions for bulk actions (D-57)', () => {
  it('a bulk verify on a stale row is refused', () => {
    const row = wp.lines({ area: 'business' }).find((l) => l.key === 'SchC.1')!;
    wp.proposeAdjustment(A('st-03'), row.id, 151300, '1099-K inside Atlas receipts');
    expect(() => wp.verify(A('st-02'), [row.id], 'recalculated', undefined, [], { [row.id]: row.revision })).toThrow(/changed this since you opened it/);
  });
});

describe('areas considered carry who, when and note', () => {
  it('fills the area DTO from the latest mark', () => {
    wp.commit(A('st-01'), [{ type: 'area.considered', payload: { areaId: 'business', note: 'Reviewed Schedule C' } }]);
    expect(wp.areas().find((a) => a.id === 'business')).toMatchObject({ considered: true, consideredBy: 'st-01', consideredNote: 'Reviewed Schedule C' });
  });
});

describe('pending judgment calls come from the server (D-61)', () => {
  it('lists the calls with exact issue ids and settles them by judgment', () => {
    const calls = pendingJudgments(wp);
    const hvac = calls.find((c) => c.key === 'whatif:hvac')!;
    expect(hvac.issueIds.some((id) => id.startsWith('chk:judgment.'))).toBe(true);
    expect(calls.map((c) => c.key)).toEqual(expect.arrayContaining(['whatif:equipment', 'whatif:hvac', 'whatif:deduction', 'whatif:penalty_method', 'due-diligence']));
    wp.commit(A('st-01'), [
      { type: 'judgment.recorded', payload: { judgmentId: 'j1', kind: 'judgment', topic: hvac.topic, decision: 'Capitalize', alternatives: [], authority: 'Reg. 1.263(a)-3', nodeIds: hvac.nodeIds, issueIds: hvac.issueIds } },
    ]);
    expect(pendingJudgments(wp).find((c) => c.key === 'whatif:hvac')!.decidedIds).toEqual(['j1']);
  });
});

describe('compare covers every engine step (gap)', () => {
  it('v1 → v3 lists both steps; adjusted rows show engine value and reason', async () => {
    wp.proposeAdjustment(A('st-01'), 'line:v3:SchB.1.2', 0, 'Duplicate of D28');
    const app = Fastify();
    registerRoutes(app, wp);
    const r = (await app.inject({ method: 'GET', url: '/api/versions/compare?a=v1&b=v3', headers: { 'x-actor': 'st-01' } })).json();
    expect(r.engineSteps.map((s: any) => s.version)).toEqual(['v2', 'v3']);
    const row = r.diffs.find((d: any) => d.key === 'SchB.1.2');
    expect(row).toMatchObject({ b: 0, bEngine: 1840, adjusted: true, adjustmentReason: 'Duplicate of D28', adjustedBy: 'st-01' });
  });
});

describe('any e-file rejection blocks resubmission until a confirmed fix (D-62)', () => {
  it('records, refuses self-confirmation, and clears on confirmation', () => {
    // A rejection whose code names no household member, so no cause can be mapped.
    wp.commit(A('st-02'), [{ type: 'filing.step', payload: { step: 'submitted', data: { submissions: [{ id: 'S1-federal', jurisdiction: 'federal' }], snapshotId: 'x', contentHash: 'x', seq: 0 } } }]);
    recordResult(wp, A('st-02'), 'S1-federal', { status: 'rejected', errors: [{ code: 'IND-031-04', message: 'Prior-year AGI does not match' }] });
    const codes = () => readiness(wp).blockers.map((b) => b.code);
    expect(codes()).toContain('EFILE_REJECTION_FIX_MISSING');
    expect(() => recordRejectionFix(wp, A('st-01'), 'S1-federal', { note: 'Used prior-year AGI 228,409 from the 2024 return', refs: [] })).toThrow(/Cite the change/);
    recordRejectionFix(wp, A('st-02'), 'S1-federal', { note: 'Used prior-year AGI 228,409 from the 2024 return', refs: ['py:/return_2024/lines/F1040.11'] });
    expect(codes()).toContain('EFILE_REJECTION_FIX_UNCONFIRMED');
    expect(() => confirmRejectionFix(wp, A('st-02'), 'S1-federal')).toThrow(/may not review/);
    confirmRejectionFix(wp, A('st-03'), 'S1-federal');
    expect(codes().filter((c) => c.startsWith('EFILE_REJECTION'))).toEqual([]);
    expect(filingState(wp).submissions[0]!.status).toBe('rejected');
  });
});
