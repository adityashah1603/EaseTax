import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';
import { buildView, listViews } from '../src/views/index.ts';
import { registerRoutes } from '../src/api/routes.ts';
import { registerViewRoutes } from '../src/api/views.ts';
import type { ViewCell, ViewDto, ViewRow } from '@easetax/shared';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));
let wp: Workpaper;
beforeEach(() => {
  wp = new Workpaper(baseline, new EventStore(':memory:'));
});

const allRows = (v: ViewDto): ViewRow[] => v.sections.flatMap((s) => [...s.rows, ...(s.totals ?? [])]);
const isNum = (c: ViewCell | undefined) => typeof c?.value === 'number';

describe('views', () => {
  it('every view builds and every line-backed number carries its node id', () => {
    for (const { id } of listViews()) {
      const v = buildView(wp, id);
      expect(v.id).toBe(id);
      expect(v.sections.length).toBeGreaterThan(0);
      for (const r of allRows(v))
        for (const c of Object.values(r.cells)) if (c && c.engineValue !== undefined) expect(c.nodeId, `${id}/${r.id}`).toMatch(/^line:/);
    }
  });

  it('payments view flags the federal Q4 and California 3,500 differences', () => {
    const v = buildView(wp, 'payments');
    const fed = v.sections.find((s) => s.id === 'federal')!;
    const q4 = fed.rows.find((r) => r.cells.recordDate?.value === '2026-01-15')!;
    expect(q4.cells.claimed!.value).toBe(4000);
    expect(q4.cells.record!.value).toBe(3000);
    expect(q4.cells.difference!.value).toBe(1000);
    expect(q4.cells.claimed!.nodeId).toBe('qa:qa-41');
    expect(q4.cells.record!.nodeId).toMatch(/^agency:\/irs_account_transcript_2025\/\d+\/transactions\/3$/);
    expect(v.meta!.federal).toMatchObject({ claimed: 13000, record: 12000, difference: 1000, agreed: false });

    const ca = v.sections.find((s) => s.id === 'california')!;
    const sep = ca.rows.find((r) => r.cells.claimedDate?.value === '2025-09-15')!;
    expect(sep.cells.claimed!.value).toBe(3500);
    expect(sep.flags!.map((f) => f.code)).toContain('PAYMENT_APPLIED_OTHER_YEAR');
    expect(sep.flags!.find((f) => f.code === 'PAYMENT_APPLIED_OTHER_YEAR')!.nodeIds).toContain('agency:/ftb_account/tax_year_2024_payments_after_filing/0');
    expect(v.meta!.california).toMatchObject({ claimed: 14000, record: 10500, difference: 3500 });
    expect(v.findings.some((f) => f.text.includes('3,500'))).toBe(true);
  });

  it('a reconciliation explanation marks payments as agreed', () => {
    wp.commit(wp.actor('st-01'), [{ type: 'reconciliation.explained', payload: { reconciliationId: 'payments:federal', explanation: 'Q4 was 3,000 per transcript; client misremembered', status: 'explained' } }]);
    expect((buildView(wp, 'payments').meta!.federal as any).agreed).toBe(true);
  });

  it('sales view puts the zero-basis RSU lots first, with the supplemental basis', () => {
    const v = buildView(wp, 'sales');
    const ex = v.sections.find((s) => s.id === 'exceptions')!.rows;
    expect(ex.slice(0, 3).map((r) => r.id)).toEqual(['F8949.B.N1', 'F8949.B.N3', 'F8949.E.N4']);
    expect(ex[0]!.flags![0]!.code).toBe('ZERO_BASIS');
    expect(ex[0]!.flags![0]!.nodeIds).toContain('ev:ev-0066');
    const all = v.sections.find((s) => s.id === 'lots')!.rows;
    expect(all[0]!.id).toBe('F8949.B.N1');
    expect(all).toHaveLength(295);
    // Meridian: summary 71,965 vs lots 71,715.
    const sd = v.sections.find((s) => s.id === 'summary-vs-detail')!.rows.find((r) => r.id === 'D31')!;
    expect(sd.cells.difference!.value).toBe(250);
  });

  it('sales lots show effective gain next to the engine gain after an adjustment', () => {
    wp.proposeAdjustment(wp.actor('st-03'), 'line:v3:F8949.B.N1', 140, 'Basis 19,100 per D11 supplemental statement');
    const row = buildView(wp, 'sales').sections.find((s) => s.id === 'lots')!.rows.find((r) => r.id === 'F8949.B.N1')!;
    expect(row.cells.gain).toMatchObject({ value: 140, engineValue: 19240, adjusted: true, nodeId: 'line:v3:F8949.B.N1' });
  });

  it('summary vs prior applies the firm variance rule', () => {
    const v = buildView(wp, 'summary-vs-prior');
    const agi = allRows(v).find((r) => r.id === 'F1040.11')!;
    expect(agi.cells.prior!.value).toBe(228409);
    expect(agi.cells.delta!.value).toBe(445590 - 228409);
    expect(agi.status).toBe('needs explanation');
    wp.commit(wp.actor('st-01'), [{ type: 'variance.explained', payload: { nodeId: 'line:v3:F1040.11', explanation: 'RSU/ISO, condo sale' } }]);
    expect(allRows(buildView(wp, 'summary-vs-prior')).find((r) => r.id === 'F1040.11')!.status).toBe('explained');
  });

  it('books-to-tax bridge ties to Schedule C net profit and flags the 1099-K overlap', () => {
    const v = buildView(wp, 'books-to-tax');
    const totals = v.sections[0]!.totals!;
    expect(totals.find((r) => r.id === 'unexplained')!.cells.effect!.value).toBe(0);
    expect(v.findings.map((f) => f.code)).toContain('RECEIPTS_1099K_OVERLAP');
  });

  it('state split re-foots column D and flags full-year California wages', () => {
    const v = buildView(wp, 'state-split');
    const rows = v.sections.find((s) => s.id === 'schca')!.rows;
    for (const r of rows) if (isNum(r.cells.A) && isNum(r.cells.D)) expect(r.cells.recalcD!.value).toBe(r.cells.D!.value);
    expect(v.findings.map((f) => f.code)).toContain('FULL_YEAR_CA_SOURCE');
    expect(v.meta!.caDays).toBe(195);
  });

  it('deductions view applies the 1098-C cap to the car donation', () => {
    const v = buildView(wp, 'deductions-credits');
    const f = v.findings.find((x) => x.code === 'VEHICLE_OVER_1098C')!;
    expect(f.text).toContain('3,100');
    expect(f.nodeIds).toContain('line:v3:F8283.A1.vehicle');
  });

  it('basis view rolls S corp basis through the 2023 K-1 to Form 7203 line 1', () => {
    const v = buildView(wp, 'basis');
    const s = v.sections.find((x) => x.id === 'scorp')!;
    expect(s.rows.find((r) => r.id === 'scorp-2024')!.cells.computed!.value).toBe(2300);
    expect(v.findings.map((f) => f.code)).not.toContain('BASIS_ROLL');
  });

  it('completeness lists outside filings with status', () => {
    const v = buildView(wp, 'completeness');
    const of = v.sections.find((s) => s.id === 'outside-filings')!.rows;
    expect(of.map((r) => r.id)).toEqual(expect.arrayContaining(['fbar', '1099-nec', 'form-709', 'form-3520']));
    expect(of.find((r) => r.id === 'fbar')!.status).toBe('open');
    wp.commit(wp.actor('st-01'), [{ type: 'judgment.recorded', payload: { judgmentId: 'j1', kind: 'judgment', topic: 'FBAR', decision: 'Client files FinCEN 114 himself; reminded', alternatives: [], authority: '31 CFR 1010.350', nodeIds: [] } }]);
    expect(buildView(wp, 'completeness').sections.find((s) => s.id === 'outside-filings')!.rows.find((r) => r.id === 'fbar')!.status).toBe('addressed');
  });

  it('serves views over HTTP and keeps them from the client portal', async () => {
    const app = Fastify();
    registerRoutes(app, wp);
    registerViewRoutes(app, wp);
    const list = await app.inject({ method: 'GET', url: '/api/views' });
    expect(list.json()).toHaveLength(15);
    const v = await app.inject({ method: 'GET', url: '/api/views/carryovers', headers: { 'x-actor': 'st-02' } });
    expect(v.statusCode).toBe(200);
    expect(v.json().id).toBe('carryovers');
    expect((await app.inject({ method: 'GET', url: '/api/views/nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/views/payments', headers: { 'x-actor': 'cu-01' } })).statusCode).toBe(403);
  });
});
