import { beforeEach, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';
import { registerRoutes } from '../src/api/routes.ts';
import { registerInboxRoutes } from '../src/api/inbox.ts';
import { inboxFor, mentions } from '../src/inbox/inbox.ts';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));
let wp: Workpaper;
const actor = (id: string) => wp.actor(id);
const inbox = (id: string) => inboxFor(wp, actor(id)).items;
const W2 = 'line:v3:F1040.1a';

beforeEach(() => {
  wp = new Workpaper(baseline, new EventStore(':memory:'));
});

describe('inbox', () => {
  it('an assignment notifies the assignee only', () => {
    const [e] = wp.commit(actor('st-02'), [
      { type: 'assignment.created', payload: { assignmentId: 'a1', scope: 'area:wages_and_stock_compensation', assignee: 'st-01', due: '2026-03-01', text: 'Tie out the W-2s' } },
    ]);
    const mine = inbox('st-01');
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ id: `${e!.id}:st-01`, kind: 'assigned', due: '2026-03-01', actor: 'st-02', done: false, read: false, route: '/areas/wages_and_stock_compensation' });
    expect(mine[0]!.title).toContain('Tie out the W-2s');
    for (const other of ['st-02', 'st-03', 'st-04', 'cu-01']) expect(inbox(other)).toEqual([]);

    wp.commit(actor('st-01'), [{ type: 'assignment.completed', payload: { assignmentId: 'a1' } }]);
    expect(inbox('st-01')[0]!.done).toBe(true);
  });

  it('notifies people @mentioned by id or full name, not the author', () => {
    wp.commit(actor('st-02'), [{ type: 'note.created', payload: { noteId: 'n1', nodeIds: [W2], text: 'Can @st-01 and Helen Strand look at this?', blocking: false } }]);
    expect(inbox('st-01').map((i) => i.kind)).toEqual(['mentioned']);
    expect(inbox('st-03').map((i) => i.kind)).toEqual(['mentioned']);
    expect(inbox('st-03')[0]!.nodeIds).toEqual([W2]);
    expect(inbox('st-02')).toEqual([]);
    expect(inbox('st-04')).toEqual([]);
    expect(mentions('ping @st-011', actor('st-01'))).toBe(false);
    expect(mentions('email st-01@firm', actor('st-01'))).toBe(false);
  });

  it("a reopened sign-off notifies its signer with what changed", () => {
    wp.signoff(actor('st-01'), 'area:wages_and_stock_compensation', 'preparer');
    const current = wp.lineValue('F1040.1a') as number;
    const [adj] = wp.proposeAdjustment(actor('st-04'), W2, current + 100, 'Missed bonus');
    const so = [...wp.state.signoffs.values()][0]!;
    expect(so.status).toBe('reopened');
    const items = inbox('st-01');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'signoff_reopened', actor: 'st-04', seq: adj!.seq, nodeIds: [W2], done: false });
    expect(items[0]!.id).toBe(`${adj!.id}:st-01:reopened:${so.id}`);
    expect(items[0]!.title).toContain('Wages & stock compensation');
    expect(inbox('st-02')).toEqual([]);
  });

  it('a proposed adjustment over $1,000 notifies the partner (st-03) until decided', () => {
    const current = wp.lineValue('F1040.1a') as number;
    const [e] = wp.proposeAdjustment(actor('st-01'), W2, current + 100000, 'Bonus not on W-2');
    expect((e!.payload as { requiresPartner: boolean }).requiresPartner).toBe(true);
    const partner = inbox('st-03');
    expect(partner.map((i) => i.kind)).toEqual(['approval_needed']);
    expect(partner[0]).toMatchObject({ nodeIds: [W2], done: false });
    expect(inbox('st-02')).toEqual([]);
    expect(inbox('st-01')).toEqual([]);

    wp.decideAdjustment(actor('st-03'), (e!.payload as { adjustmentId: string }).adjustmentId, 'reject', 'Need the bonus letter');
    expect(inbox('st-03')[0]!.done).toBe(true);
    expect(inbox('st-01').map((i) => i.kind)).toEqual(['adjustment_decided']);
  });

  it('a client sees questions addressed to the client, masked, and nothing staff-only', () => {
    wp.commit(actor('st-01'), [
      { type: 'question.asked', payload: { questionId: 'q1', to: 'client', nodeIds: ['household:theo'], text: "Is 123-45-6789 Theo's SSN?" } },
      { type: 'question.asked', payload: { questionId: 'q2', to: 'st-02', nodeIds: [W2], text: 'Reviewer only' } },
      { type: 'note.created', payload: { noteId: 'n1', nodeIds: [W2], text: 'Ngozi Okafor said her bonus was paid in January', blocking: true } },
    ]);
    const client = inbox('cu-01');
    expect(client.map((i) => i.kind)).toEqual(['question']);
    expect(client[0]!.nodeIds).toEqual([]);
    const text = JSON.stringify(client);
    expect(text).not.toContain('123-45-6789');
    expect(text).toContain('***-**-6789');
    expect(text).not.toContain('Reviewer only');
    expect(text).not.toContain('bonus');
    expect(inbox('st-02').map((i) => i.kind)).toEqual(['question']);

    wp.commit(actor('cu-01'), [{ type: 'question.answered', payload: { questionId: 'q1', text: 'Yes' } }]);
    expect(inbox('cu-01')[0]!.done).toBe(true);
    expect(inbox('st-01').map((i) => i.kind)).toEqual(['answer']);
  });

  it('a blocking note on an area a reviewer signed reaches the reviewer', () => {
    wp.signoff(actor('st-02'), 'area:wages_and_stock_compensation', 'reviewer');
    wp.commit(actor('st-03'), [{ type: 'note.created', payload: { noteId: 'n1', nodeIds: [W2], text: 'Support for the bonus?', blocking: true } }]);
    expect(inbox('st-02').map((i) => i.kind)).toEqual(['blocking_note']);
    wp.commit(actor('st-01'), [{ type: 'note.replied', payload: { noteId: 'n1', text: 'Attached the letter' } }]);
    expect(inbox('st-03').map((i) => i.kind)).toEqual(['note_replied']);
  });

  it('tells the client when approval opens and when it goes stale', async () => {
    const { recordClientApproval } = await import('../src/filing/commands.ts');
    wp.signoff(actor('st-03'), 'return', 'partner');
    expect(inbox('cu-01').map((i) => i.kind)).toEqual(['approval_opened']);
    recordClientApproval(wp, actor('cu-01'), { pins: { 'cu-01': '12345', 'cu-02': '54321' }, consent: true });
    expect(inbox('cu-01')[0]!.done).toBe(true);
    const current = wp.lineValue('F1040.1a') as number;
    wp.proposeAdjustment(actor('st-01'), W2, current + 100, 'Missed bonus');
    const items = inbox('cu-02');
    expect(items.map((i) => i.kind)).toEqual(['approval_stale', 'approval_opened']);
    expect(items[0]!.actor).toBe('st-01');
    expect(JSON.stringify(items)).not.toContain('line:');
  });

  it('GET /api/inbox is open to clients and staff, and refuses unknown actors', async () => {
    const app = Fastify();
    registerRoutes(app, wp);
    registerInboxRoutes(app, wp);
    const get = (id?: string) => app.inject({ method: 'GET', url: '/api/inbox', headers: id ? { 'x-actor': id } : {} });
    expect((await get('cu-01')).statusCode).toBe(200);
    const r = await get('st-01');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ actor: 'st-01', items: [] });
    expect((await get()).statusCode).toBe(403);
  });
});

describe('read marks are server-side events (D-59)', () => {
  it('marks read and unread, only within your own inbox, and stays out of since-last-seen', async () => {
    const { resolve } = await import('node:path');
    const Fastify = (await import('fastify')).default;
    const { loadBaseline } = await import('../src/baseline/baseline.ts');
    const { EventStore } = await import('../src/events/store.ts');
    const { Workpaper } = await import('../src/workpaper.ts');
    const { registerRoutes } = await import('../src/api/routes.ts');
    const { registerInboxRoutes } = await import('../src/api/inbox.ts');
    const wp = new Workpaper(loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json')), new EventStore(':memory:'));
    const app = Fastify();
    registerRoutes(app, wp);
    registerInboxRoutes(app, wp);
    wp.commit(wp.actor('st-02'), [{ type: 'assignment.created', payload: { assignmentId: 'as1', scope: 'area:business', assignee: 'st-01', text: 'Tie out Schedule C' } }]);
    const get = async (actor: string) => (await app.inject({ method: 'GET', url: '/api/inbox', headers: { 'x-actor': actor } })).json();
    const item = (await get('st-01')).items[0];
    expect(item.read).toBe(false);
    const post = (actor: string, body: unknown) => app.inject({ method: 'POST', url: '/api/inbox/read', headers: { 'x-actor': actor }, payload: body });
    expect((await post('st-01', { ids: [item.id] })).statusCode).toBe(200);
    expect((await get('st-01')).items[0].read).toBe(true);
    await post('st-01', { ids: [item.id], read: false });
    expect((await get('st-01')).items[0].read).toBe(false);
    expect((await post('st-03', { ids: [item.id] })).statusCode).toBe(400); // not in Helen's inbox
    const since = (await app.inject({ method: 'GET', url: '/api/changes/since-last-seen', headers: { 'x-actor': 'st-02' } })).json();
    expect(since.events.some((e: any) => e.type === 'notification.read')).toBe(false);
  });
});
