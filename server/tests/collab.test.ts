import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';
import { registerRoutes } from '../src/api/routes.ts';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));
let wp: Workpaper;
const A = (id: string) => wp.actor(id);

beforeEach(() => {
  wp = new Workpaper(baseline, new EventStore(':memory:'));
});

describe('stale writes are refused (D-57)', () => {
  it('a node revision moves with value and verification events only', () => {
    const id = 'line:v3:SchB.1.2';
    expect(wp.revision(id)).toBe(0);
    wp.commit(A('st-01'), [{ type: 'note.created', payload: { noteId: 'n1', nodeIds: [id], text: 'fyi', blocking: false } }]);
    expect(wp.revision(id)).toBe(0);
    const [e] = wp.proposeAdjustment(A('st-01'), id, 0, 'duplicate');
    expect(wp.revision(id)).toBe(e!.seq);
    expect(wp.summarize(id).revision).toBe(e!.seq);
  });

  it("refuses an adjustment made on a view someone else has since changed, and says who", () => {
    const id = 'line:v3:SchB.1.2';
    const seen = wp.revision(id); // Daniel opens the line
    wp.proposeAdjustment(A('st-01'), id, 0, 'duplicate'); // Priya adjusts it
    let err: any;
    try {
      wp.proposeAdjustment(A('st-02'), id, 100, 'my view', undefined, seen);
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('conflict');
    expect(err.message).toMatch(/Priya Raman changed this since you opened it/);
    expect(err.details.changes.map((c: any) => c.type)).toEqual(['adjustment.proposed']);
    // Retrying on the current revision works.
    expect(() => wp.proposeAdjustment(A('st-02'), id, 100, 'reviewed the change', undefined, wp.revision(id))).not.toThrow();
  });

  it('applies to verifications (per node), read corrections and household corrections', () => {
    const seen = wp.revision('ev:ev-1045');
    wp.verify(A('st-01'), ['ev:ev-1045'], 'agreed_to_source_document');
    expect(() => wp.verify(A('st-02'), ['ev:ev-1045', 'ev:ev-0016'], 'recalculated', undefined, [], { 'ev:ev-1045': seen })).toThrow(/changed this since you opened it/);
    expect(() => wp.correctRead(A('st-02'), 'ev:ev-1045', '74-3829156', 'per page', seen)).toThrow(/changed this/);
    const h = wp.revision('household:theo');
    wp.correctHousehold(A('st-01'), 'theo', 'ssn', '666-74-3390', 'msg:msg-10', 'typo');
    expect(() => wp.correctHousehold(A('st-03'), 'theo', 'name', 'Theo L-O', 'msg:msg-10', 'x', h)).toThrow(/changed this/);
  });

  it('returns 409 with the changes over HTTP, masked', async () => {
    const app = Fastify();
    registerRoutes(app, wp);
    const seen = wp.revision('household:theo');
    wp.correctHousehold(A('st-01'), 'theo', 'ssn', '666-74-3390', 'msg:msg-10', 'typo');
    const r = await app.inject({
      method: 'POST',
      url: '/api/household/corrections',
      headers: { 'x-actor': 'st-02' },
      payload: { personId: 'theo', field: 'ssn', value: '666-74-3391', evidenceId: 'msg:msg-10', reason: 'x', revision: seen },
    });
    expect(r.statusCode).toBe(409);
    const body = r.json();
    expect(body.details.changes[0].type).toBe('household.corrected');
    expect(r.body).not.toContain('666-74-3390');
  });
});

describe('related returns (D-58)', () => {
  it('are traceable nodes linked to their K-1s and to the filer', () => {
    expect(wp.g.nodes.has('related:ada-1040')).toBe(true);
    expect(wp.g.children('related:lindqvist-family-woodworks-inc').map((e) => e.to)).toEqual(expect.arrayContaining(['doc:D39', 'doc:D40']));
    expect(wp.g.children('related:ridgeline-real-estate-fund-iii-lp').map((e) => e.to)).toEqual(expect.arrayContaining(['doc:D37', 'doc:D38']));
    expect(wp.g.children('household:ada').map((e) => e.to)).toContain('related:ada-1040');
    expect(wp.summarize('related:ada-1040').label).toMatch(/Ada Lindqvist-Okafor: 2025 Form 1040/);
  });

  it('report consistency: Ada can be claimed; every carried K-1 amount agrees', () => {
    const ada = wp.nodeDetail('related:ada-1040', A('st-01')).consistency!;
    expect(ada).toEqual([expect.objectContaining({ check: 'Dependent status', ok: true })]);
    const wood = wp.nodeDetail('related:lindqvist-family-woodworks-inc', A('st-01')).consistency!;
    expect(wood.length).toBeGreaterThan(0);
    expect(wood.every((c) => c.ok)).toBe(true);
    expect(wp.issues().some((i) => i.id.startsWith('chk:related.'))).toBe(false);
  });

  it('flags a K-1 amount that no longer agrees with the line it feeds', () => {
    wp.proposeAdjustment(A('st-03'), 'line:v3:SchE.28A', 10000, 'test: diverge from the K-1');
    const issue = wp.issues().find((i) => i.code === 'K1_RETURN_MISMATCH');
    expect(issue?.nodeIds).toEqual(expect.arrayContaining(['related:lindqvist-family-woodworks-inc', 'line:v3:SchE.28A']));
  });
});
