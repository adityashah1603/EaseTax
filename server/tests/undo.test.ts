import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';
import { registerRoutes } from '../src/api/routes.ts';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));
let wp: Workpaper;
let app: FastifyInstance;
const A = (id: string) => wp.actor(id);
const EIN = 'chk:read.printed:ev-1045';
const post = (actor: string, url: string, payload?: unknown) => app.inject({ method: 'POST', url, headers: { 'x-actor': actor }, payload: payload as any });
const issue = (id: string) => wp.issues().find((i) => i.id === id)!;

beforeEach(() => {
  wp = new Workpaper(baseline, new EventStore(':memory:'));
  app = Fastify();
  registerRoutes(app, wp);
});

describe('closing an error needs a real reason and a second person (D-65)', () => {
  it('refuses a placeholder reason', async () => {
    const r = await post('st-01', '/api/issues/resolve', { issueIds: [EIN], status: 'accepted', resolution: '123' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/at least 3 words/);
    expect(issue(EIN).status).toBe('open');
  });

  it('stays open until a different reviewer or partner confirms', async () => {
    expect(issue(EIN).severity).toBe('error');
    const reason = 'EIN on the 1099 matches the payer letter on file';
    expect((await post('st-01', '/api/issues/resolve', { issueIds: [EIN], status: 'accepted', resolution: reason })).statusCode).toBe(200);
    expect(issue(EIN)).toMatchObject({ status: 'open', awaitingConfirmation: { status: 'accepted', by: 'st-01', resolution: reason } });
    // A preparer cannot confirm at all.
    expect((await post('st-01', `/api/issues/${encodeURIComponent(EIN)}/confirm`)).statusCode).toBe(403);
    expect((await post('st-02', `/api/issues/${encodeURIComponent(EIN)}/confirm`)).statusCode).toBe(200);
    expect(issue(EIN)).toMatchObject({ status: 'accepted', closedBy: 'st-01', confirmedBy: 'st-02' });
  });

  it('no one confirms their own closure', async () => {
    await post('st-03', '/api/issues/resolve', { issueIds: [EIN], status: 'accepted', resolution: 'Partner reviewed the payer letter' });
    const r = await post('st-03', `/api/issues/${encodeURIComponent(EIN)}/confirm`);
    expect(r.json().error).toMatch(/may not review/);
    expect(issue(EIN).status).toBe('open');
  });

  it('a warning closes at once, and reopening records the reason', async () => {
    const w = wp.issues().find((i) => i.status === 'open' && i.severity === 'warning' && i.source === 'check')!;
    await post('st-01', '/api/issues/resolve', { issueIds: [w.id], status: 'accepted', resolution: 'Immaterial difference, under the firm threshold' });
    expect(issue(w.id).status).toBe('accepted');
    await post('st-02', `/api/issues/${encodeURIComponent(w.id)}/reopen`, { reason: 'Need the source for this one' });
    expect(issue(w.id).status).toBe('open');
    expect(wp.state.events.at(-1)!.reason).toBe('Need the source for this one');
  });
});

describe('my recent actions (D-65)', () => {
  it('lists my own actions newest first and undoes an older one', async () => {
    const reason = 'EIN on the 1099 matches the payer letter on file';
    await post('st-01', '/api/issues/resolve', { issueIds: [EIN], status: 'accepted', resolution: reason });
    wp.verify(A('st-01'), ['line:v3:F1040.1a'], 'recalculated');
    wp.verify(A('st-02'), ['line:v3:F1040.2b'], 'recalculated');
    const mine = (await app.inject({ method: 'GET', url: '/api/my-actions', headers: { 'x-actor': 'st-01' } })).json();
    expect(mine.map((m: any) => m.events[0].type)).toEqual(['verification.added', 'issue.resolved']);
    expect(mine[1]).toMatchObject({ undone: false, undoable: true });
    // Undo the older action, well after the 12-second toast.
    expect((await post('st-01', '/api/undo', mine[1].target)).statusCode).toBe(200);
    expect(issue(EIN).awaitingConfirmation).toBeUndefined();
    const after = (await app.inject({ method: 'GET', url: '/api/my-actions', headers: { 'x-actor': 'st-01' } })).json();
    expect(after[1].undone).toBe(true);
  });

  it('keeps the access log and filing steps on the record', async () => {
    wp.commit(A('st-01'), [{ type: 'sensitive.unmasked', payload: { nodeId: 'household:theo', field: 'ssn' } }]);
    const [m] = wp.myActions(A('st-01'));
    expect(m).toMatchObject({ undoable: false, whyNot: expect.stringMatching(/access log/) });
    expect(() => wp.undo(A('st-01'), m!.target as any)).toThrow(/can't be undone/);
    const [f] = wp.commit(A('st-02'), [{ type: 'filing.step', payload: { step: 'extension' } }]);
    expect(() => wp.undo(A('st-02'), { eventId: f!.id })).toThrow(/can't be undone/);
  });
});
