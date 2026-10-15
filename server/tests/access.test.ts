import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { loadBaseline } from '../src/baseline/baseline.ts';
import { EventStore } from '../src/events/store.ts';
import { Workpaper } from '../src/workpaper.ts';
import { registerRoutes } from '../src/api/routes.ts';
import { registerViewRoutes } from '../src/api/views.ts';
import { registerFilingRoutes } from '../src/api/filing.ts';

const baseline = loadBaseline(resolve(__dirname, '../../okafor_lindqvist_2025_packet.json'));

function app() {
  const wp = new Workpaper(baseline, new EventStore(':memory:'));
  const a = Fastify();
  registerRoutes(a, wp);
  registerViewRoutes(a, wp);
  registerFilingRoutes(a, wp);
  return a;
}

const get = (a: ReturnType<typeof app>, url: string, actor?: string) =>
  a.inject({ method: 'GET', url, headers: actor ? { 'x-actor': actor } : {} }).then((r) => r.statusCode);

describe('API access gate (D-09, D-35)', () => {
  it('refuses any request that does not name a known actor', async () => {
    const a = app();
    expect(await get(a, '/api/summary')).toBe(403);
    expect(await get(a, '/api/summary', 'nobody')).toBe(403);
    expect(await get(a, '/api/summary', 'st-01')).toBe(200);
  });

  it('keeps clients on the portal routes', async () => {
    const a = app();
    for (const url of ['/api/me', '/api/summary', '/api/questions', '/api/filing/status']) expect(await get(a, url, 'cu-01')).toBe(200);
    for (const url of ['/api/issues', '/api/lines', '/api/documents', '/api/nodes/household%3Atheo', '/api/views', '/api/events', '/api/firm/standards'])
      expect(await get(a, url, 'cu-01')).toBe(403);
  });

  it('explains role refusals in plain words', async () => {
    const r = await app().inject({ method: 'POST', url: '/api/filing/submit', headers: { 'x-actor': 'st-01' } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('Priya Raman (preparer) cannot file, extend or record e-file results');
  });
});
