import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';
import { registerRoutes } from '../src/api/routes.ts';
import { registerStream } from '../src/realtime/stream.ts';
import { registerInboxRoutes } from '../src/api/inbox.ts';
import { maskFreeText } from '../src/policy/policy.ts';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));
let wp: Workpaper;
let app: FastifyInstance;
const A = (id: string) => wp.actor(id);
const LINE = 'line:v3:F1040.1a';
const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', actor: string | undefined, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: actor ? { 'x-actor': actor } : {}, payload: payload as any });

beforeEach(() => {
  // st-06 (quality reviewer) starts 2027-01-04; pin "today" before that.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-16T12:00:00Z'));
  wp = new Workpaper(baseline, new EventStore(':memory:'));
  app = Fastify();
  registerRoutes(app, wp);
  registerStream(app, wp);
  registerInboxRoutes(app, wp);
});
afterEach(async () => {
  vi.useRealTimers();
  await app.close();
});

describe('live stream (D-11)', () => {
  it('admits known, started staff only', async () => {
    expect((await req('GET', undefined, '/api/stream')).statusCode).toBe(403);
    expect((await req('GET', undefined, '/api/stream?actor=nobody')).statusCode).toBe(403);
    expect((await req('GET', undefined, '/api/stream?actor=cu-01')).statusCode).toBe(403);
    const late = await req('GET', undefined, '/api/stream?actor=st-06');
    expect(late.statusCode).toBe(403);
    expect(late.json().error).toMatch(/starts on 2027-01-04/);
  });

  it('announces events without payload or reason, and presence follows X-Actor', async () => {
    await app.listen({ port: 0, host: '127.0.0.1' });
    const port = (app.server.address() as { port: number }).port;
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/stream?actor=st-02`, { signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const until = async (needle: string) => {
      while (!buf.includes(needle)) buf += dec.decode((await reader.read()).value);
    };
    await until('event: hello');

    // Someone else claims to move st-02's focus: the body's actor is ignored.
    await req('POST', 'st-03', '/api/presence', { actor: 'st-02', focus: 'spoofed' });
    await until('"actor":"st-02"');
    expect(buf).not.toContain('spoofed');

    wp.commit(A('st-01'), [{ type: 'note.created', payload: { noteId: 'n1', nodeIds: [LINE], text: 'Secret wages note 123-45-6789', blocking: false }, reason: 'private reason' }]);
    await until('event: events');
    const data = JSON.parse(buf.split('event: events\ndata: ')[1]!.split('\n')[0]!);
    expect(data).toEqual([{ seq: expect.any(Number), id: expect.any(String), type: 'note.created', actor: 'st-01', at: expect.any(String) }]);
    expect(buf).not.toMatch(/Secret|6789|private reason/);
    ac.abort();
  });
});

describe('staff start dates', () => {
  it('a person who has not started may load the session and nothing else', async () => {
    const me = await req('GET', 'st-06', '/api/me');
    expect(me.statusCode).toBe(200);
    expect(me.json().actor.activeFrom).toBe('2027-01-04');
    const r = await req('GET', 'st-06', '/api/summary');
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe(`${A('st-06').name} starts on 2027-01-04`);
    expect((await req('POST', 'st-06', '/api/notes', { nodeIds: [LINE], text: 'hello there' })).statusCode).toBe(403);
    expect(() => wp.verify(A('st-06'), [LINE], 'agreed_to_source_document')).toThrow(/starts on/);
  });

  it('access opens on the start date', async () => {
    vi.setSystemTime(new Date('2027-01-04T12:00:00Z'));
    expect((await req('GET', 'st-06', '/api/summary')).statusCode).toBe(200);
  });
});

describe('removing a verification', () => {
  const verId = () => [...wp.state.verifications.values()].find((v) => v.nodeId === LINE)!.id;
  beforeEach(() => wp.verify(A('st-01'), [LINE], 'agreed_to_source_document'));

  it('404s on an unknown id', async () => {
    expect((await req('DELETE', 'st-01', '/api/verifications/nope', { reason: 'wrong line' })).statusCode).toBe(404);
  });

  it('needs a reason', async () => {
    const r = await req('DELETE', 'st-01', `/api/verifications/${verId()}`);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Say why/);
  });

  it('only the verifier, a reviewer or a partner', async () => {
    expect((await req('DELETE', 'st-04', `/api/verifications/${verId()}`, { reason: 'not mine to keep' })).statusCode).toBe(403);
    const r = await req('DELETE', 'st-02', `/api/verifications/${verId()}`, { reason: 'Verified against the wrong W-2' });
    expect(r.statusCode).toBe(200);
    expect(wp.state.events.at(-1)).toMatchObject({ type: 'verification.removed', actor: 'st-02', reason: 'Verified against the wrong W-2' });
    expect(wp.state.verifications.size).toBe(0);
  });

  it('takes the reason from the query string too', async () => {
    const r = await req('DELETE', 'st-01', `/api/verifications/${verId()}?reason=${encodeURIComponent('duplicate of another tick')}`);
    expect(r.statusCode).toBe(200);
    expect(wp.state.events.at(-1)!.reason).toBe('duplicate of another tick');
  });
});

describe('input validation', () => {
  it('rejects an unknown note action', async () => {
    const r = await req('POST', 'st-01', '/api/notes/whatever/delete', {});
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/reply, resolve or reopen/);
  });

  it('rejects an unknown disposition status and an unknown document', async () => {
    const doc = wp.documents()[0]!.id;
    const r = await req('PUT', 'st-01', `/api/documents/${doc}/disposition`, { status: 'burned', note: 'gone' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Status must be one of: used, duplicate/);
    expect((await req('PUT', 'st-01', '/api/documents/NOPE/disposition', { status: 'used' })).statusCode).toBe(404);
    expect((await req('PUT', 'st-01', `/api/documents/${doc}/disposition`, { status: 'used' })).statusCode).toBe(200);
  });

  it('rejects an unknown judgment kind', async () => {
    const r = await req('POST', 'st-01', '/api/judgments', { kind: 'vibes', topic: 't', decision: 'd', authority: 'IRC 1' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/Kind must be one of: judgment, election, due diligence, penalty/);
  });

  it('checks a variance explanation names a real line and says something', async () => {
    expect((await req('POST', 'st-01', '/api/variances/explain', { nodeId: LINE, explanation: '  ' })).statusCode).toBe(400);
    expect((await req('POST', 'st-01', '/api/variances/explain', { explanation: 'why' })).statusCode).toBe(400);
    expect((await req('POST', 'st-01', '/api/variances/explain', { nodeId: 'line:v3:NOPE', explanation: 'why' })).statusCode).toBe(404);
    const ok = await req('POST', 'st-01', '/api/variances/explain', { nodeId: LINE, explanation: 'New job mid-year', extra: 'ignored' });
    expect(ok.statusCode).toBe(200);
    expect(wp.state.events.at(-1)!.payload).toEqual({ nodeId: LINE, explanation: 'New job mid-year' });
  });
});

describe('opening an uploaded file is logged', () => {
  const put = () => {
    wp.store.putAttachment({ id: 'f1', name: 'w2.pdf', mime: 'application/pdf', size: 3, sha256: 'x', data: Buffer.from('pdf') });
    wp.commit(A('st-01'), [{ type: 'attachment.added', payload: { attachmentId: 'f1', kind: 'file', name: 'w2.pdf', mime: 'application/pdf', size: 3, sha256: 'x' } }]);
  };

  it('records who opened it in the access log, not in my actions, and it cannot be undone', async () => {
    put();
    expect((await req('GET', undefined, '/api/attachments/f1/file')).statusCode).toBe(403);
    const r = await req('GET', undefined, '/api/attachments/f1/file?actor=st-02');
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('pdf');
    const log = (await req('GET', 'st-05', '/api/firm/access-log')).json();
    expect(log).toContainEqual(expect.objectContaining({ actor: 'st-02', nodeId: 'att:f1', field: 'file' }));
    expect(wp.myActions(A('st-02'))).toHaveLength(0);
    const opened = wp.state.events.at(-1)!;
    expect(opened.type).toBe('attachment.opened');
    expect((await req('POST', 'st-02', '/api/undo', { eventId: opened.id })).statusCode).toBe(409);
    const since = (await req('GET', 'st-01', '/api/changes/since-last-seen')).json();
    expect(since.events.some((e: any) => e.type === 'attachment.opened')).toBe(false);
  });
});

describe('free-text masking (D-10)', () => {
  const SSN = '123-45-6789';
  const BARE_SSN = '987654321';
  const ACCOUNT = '000123456789';

  it('masks SSN-shaped text and long digit runs, keeping the last 4', () => {
    expect(maskFreeText(`ssn ${SSN}, bare ${BARE_SSN}, acct ${ACCOUNT}, wages 85,000, year 2025`)).toBe(
      'ssn ***-**-6789, bare ***-**-4321, acct ••••6789, wages 85,000, year 2025',
    );
  });

  it('masks notes, replies, questions and answers wherever they leave the server; storage stays raw', async () => {
    await req('POST', 'st-01', '/api/notes', { nodeIds: [LINE], text: `Client SSN ${BARE_SSN} on file` });
    const note = [...wp.state.notes.values()][0]!;
    await req('POST', 'st-02', `/api/notes/${note.id}/reply`, { text: `Refund to ${ACCOUNT}` });
    await req('POST', 'st-01', '/api/questions', { to: 'client', nodeIds: [LINE], text: `Is ${SSN} your SSN?` });
    const q = [...wp.state.questions.values()][0]!;
    await req('POST', 'cu-01', `/api/questions/${q.id}/answer`, { text: `Yes, and my account is ${ACCOUNT}` });

    const bodies = [
      (await req('GET', 'st-01', '/api/notes')).body,
      (await req('GET', 'st-01', '/api/questions')).body,
      (await req('GET', 'cu-01', '/api/questions')).body,
      (await req('GET', 'st-01', `/api/nodes/${encodeURIComponent(LINE)}`)).body,
      (await req('GET', 'st-01', '/api/events')).body,
      (await req('GET', 'st-03', '/api/changes/since-last-seen')).body,
      (await req('GET', 'st-01', '/api/my-actions')).body,
      (await req('GET', 'st-01', '/api/inbox')).body,
      (await req('GET', 'cu-01', '/api/inbox')).body,
      (await req('GET', 'st-01', `/api/nodes/${encodeURIComponent(`note:${note.id}`)}`)).body,
    ];
    for (const b of bodies) {
      expect(b).not.toContain(SSN);
      expect(b).not.toContain(BARE_SSN);
      expect(b).not.toContain(ACCOUNT);
    }
    expect(bodies[0]).toContain('***-**-4321');
    expect(bodies[0]).toContain('••••6789');
    // Append-only: the stored events keep what was typed.
    expect(wp.store.all().map((e) => JSON.stringify(e.payload)).join()).toContain(BARE_SSN);
  });
});
