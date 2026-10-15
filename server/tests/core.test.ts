import { describe, expect, it, beforeEach } from 'vitest';
import { resolve } from 'node:path';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';
import { maskText } from '../src/policy/policy.ts';
import { estimateEffect, resolveRef } from '@easetax/shared';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));
let wp: Workpaper;
const actor = (id: string) => wp.actor(id);

beforeEach(() => {
  wp = new Workpaper(baseline, new EventStore(':memory:'));
});

describe('baseline', () => {
  it('loads the packet as delivered', () => {
    expect(baseline.packet.documents).toHaveLength(74);
    expect(baseline.packet.extracted_values.length).toBe(3012);
    expect(baseline.currentVersion).toBe('v3');
    expect(baseline.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('refs', () => {
  it('resolves every reference format in the README', () => {
    expect(resolveRef('ev-0016', 'v3')).toBe('ev:ev-0016');
    expect(resolveRef('D09', null)).toBe('doc:D09');
    expect(resolveRef('qa-14', 'v3')).toBe('qa:qa-14');
    expect(resolveRef('msg-04', null)).toBe('msg:msg-04');
    expect(resolveRef('py:/return_2024/K1_1065', 'v3')).toBe('py:/return_2024/K1_1065');
    expect(resolveRef('asset:SAC-BLDG', 'v3')).toBe('asset:v3:SAC-BLDG');
    expect(resolveRef('F6251.11', 'v3')).toBe('line:v3:F6251.11');
    expect(resolveRef('ref:fx.SEK.2024_average', 'v3')).toBe('ref:fx.SEK.2024_average');
  });

  it('every line source and input resolves to a known node', () => {
    const unknown: string[] = [];
    for (const v of baseline.versions)
      for (const l of v.lines)
        for (const r of [...l.sources, ...l.inputs.map((i) => i)]) {
          const id = l.inputs.includes(r) ? `line:${v.version}:${r}` : resolveRef(r, v.version);
          if (id.startsWith('line:') && !baseline.line(v.version, id.split(':')[2]!)) unknown.push(`${l.key} -> ${id}`);
          if (id.startsWith('ev:') && !baseline.evs.has(id.slice(3))) unknown.push(`${l.key} -> ${id}`);
          if (id.startsWith('py:') && wp.rawValue(id) === undefined) unknown.push(`${l.key} -> ${id}`);
          if (id.startsWith('ref:') && wp.rawValue(id) === undefined) unknown.push(`${l.key} -> ${id}`);
        }
    expect(unknown).toEqual([]);
  });
});

describe('trace', () => {
  it('traces F1040.1a down to the W-2 pages', () => {
    const t = wp.trace('line:v3:F1040.1a', 'down', 4);
    const flat = JSON.stringify(t);
    expect(flat).toContain('ev:ev-0016');
    expect(flat).toContain('doc:D08#page1');
    expect(t.node.value).toBe(212400);
  });

  it('traces a document up to where it landed', () => {
    const d = wp.documentDetail('D08');
    const fed = d.landings.flatMap((l) => l.lines.map((x) => x.id));
    expect(fed).toContain('line:v3:F1040.1a');
  });

  it('derives superseded disposition for the corrected Meridian 1099', () => {
    const d = wp.documents().find((x) => x.id === 'D30')!;
    expect(d.disposition?.status).toBe('superseded');
    expect(d.disposition?.note).toContain('D31');
  });
});

describe('masking', () => {
  it('masks SSNs and account numbers in printed content', () => {
    expect(maskText('Employee SSN 666-41-2287.')).toBe('Employee SSN ***-**-2287.');
    expect(maskText('IBAN SE45 8000 0000 0412 7783 9901')).not.toContain('0412');
    expect(maskText('Account number 4483019276')).toContain('9276');
    expect(maskText('Account number 4483019276')).not.toContain('448301');
  });

  it('never sends a raw SSN in a document detail', () => {
    const d = wp.documentDetail('D09');
    expect(JSON.stringify(d)).not.toContain('666-41-2287');
  });

  it('never sends a raw SSN in issue text', () => {
    const ssns = baseline.packet.household.people.map((p) => p.ssn);
    const text = JSON.stringify(wp.issues());
    for (const ssn of [...ssns, '666-74-3390']) expect(text).not.toContain(ssn);
  });

  it('blocks unmask for staff without clearance (st-04)', () => {
    expect(actor('st-04').clearance).toBe(false);
  });
});

describe('tax effect', () => {
  it('uses version rates per dollar', () => {
    const rates = baseline.version('v3')!.tax_effect_rates;
    const e = estimateEffect('SchB.1.2', 1840, 0, rates, 'v3');
    expect(e.estimable).toBe(true);
    expect(e.federalTax).toBeCloseTo(-1840 * rates.interest!.federal_per_dollar, 2);
  });
  it('treats Form 8949 lot values as dollars', () => {
    const rates = baseline.version('v3')!.tax_effect_rates;
    // RSU lot N1 taxed on zero basis: correcting basis to 19,100 cuts the gain from 19,240 to 140.
    const e = estimateEffect('F8949.B.N1', 19240, 140, rates, 'v3');
    expect(e.federalTax).toBeCloseTo(-19100 * rates.stcg!.federal_per_dollar, 2);
  });
  it('treats payments 1:1 against balance due', () => {
    const e = estimateEffect('F1040.26', 13000, 12000, {}, 'v3');
    expect(e.federalBalance).toBe(1000);
  });
});

describe('adjustments & policy', () => {
  it('keeps the original and layers the adjustment', () => {
    wp.proposeAdjustment(actor('st-01'), 'line:v3:SchB.1.2', 0, 'Duplicate of Northlake composite interest (D28)');
    const n = wp.nodeDetail('line:v3:SchB.1.2', actor('st-01'));
    expect(n.node.value).toBe(1840);
    expect(n.adjustments[0]!.originalValue).toBe(1840);
    // ~640 federal effect: under the partner threshold, applies immediately.
    expect(n.adjustments[0]!.status).toBe('approved');
    expect(n.node.effectiveValue).toBe(0);
  });

  it('requires a partner for adjustments with tax effect over 1,000', () => {
    wp.proposeAdjustment(actor('st-01'), 'line:v3:SchC.1', 151300, '1099-K already inside Atlas receipts');
    const adj = [...wp.state.adjustments.values()][0]!;
    expect(adj.requiresPartner).toBe(true);
    expect(adj.status).toBe('proposed');
    expect(() => wp.decideAdjustment(actor('st-02'), adj.id, 'approve')).toThrow(/cannot approve/);
    wp.decideAdjustment(actor('st-03'), adj.id, 'approve');
    expect(wp.lineValue('SchC.1')).toBe(151300);
  });

  it('refuses sign-off by someone who prepared work in scope', () => {
    wp.verify(actor('st-02'), ['line:v3:F1040.1a'], 'agreed_to_source_document');
    expect(() => wp.signoff(actor('st-02'), 'area:wages_and_stock_compensation', 'reviewer')).toThrow(/may not review/);
  });

  it('reopens a sign-off when something it covers changes', () => {
    wp.signoff(actor('st-02'), 'area:investments_and_digital_assets', 'reviewer');
    const so = [...wp.state.signoffs.values()][0]!;
    expect(so.status).toBe('valid');
    wp.proposeAdjustment(actor('st-01'), 'line:v3:SchB.1.2', 0, 'duplicate');
    expect(wp.state.signoffs.get(so.id)!.status).toBe('reopened');
  });

  it('a comment does not reopen a sign-off', () => {
    wp.signoff(actor('st-02'), 'return', 'reviewer');
    wp.commit(actor('st-01'), [{ type: 'note.created', payload: { noteId: 'n1', nodeIds: ['line:v3:F1040.11'], text: 'fyi', blocking: false } }]);
    expect([...wp.state.signoffs.values()][0]!.status).toBe('valid');
  });

  it('undoes a bulk verification as one batch', () => {
    const ev = wp.verify(actor('st-01'), ['ev:ev-0016', 'ev:ev-0035'], 'agreed_to_source_document');
    expect(wp.state.verifications.size).toBe(2);
    wp.undo(actor('st-01'), { batchId: ev[0]!.batchId });
    expect(wp.state.verifications.size).toBe(0);
  });

  it('rebuilds identical state from the log', () => {
    wp.proposeAdjustment(actor('st-01'), 'line:v3:SchB.1.2', 0, 'duplicate');
    wp.verify(actor('st-01'), ['ev:ev-0016'], 'recalculated');
    const before = JSON.stringify(wp.summary());
    wp.state.rebuild(wp.store.all());
    expect(JSON.stringify(wp.summary())).toBe(before);
  });
});
