// Server-Sent Events (D-11): every committed event is announced to connected staff,
// plus presence (who is looking at what). The routes' onRequest gate checks ?actor=
// (EventSource can't set headers) and admits known, started firm staff only.

import type { WorkEvent } from '@easetax/shared';
import type { FastifyInstance } from 'fastify';
import type { Workpaper } from '../workpaper.ts';

interface Client {
  actor: string;
  focus?: string;
  send: (event: string, data: unknown) => void;
}

/** Bookkeeping that changes nothing anyone else is looking at. */
const NOT_BROADCAST = new Set<WorkEvent['type']>(['attachment.opened']);

/**
 * What the stream says about an event: enough to know something changed and refetch.
 * Never the payload or reason; those stay behind the REST routes' policy and masking.
 */
export function streamEvent(e: WorkEvent) {
  return { seq: e.seq, id: e.id, type: e.type, actor: e.actor, at: e.at };
}

export function registerStream(app: FastifyInstance, wp: Workpaper) {
  const clients = new Set<Client>();
  const presence = () => [...clients].map((c) => ({ actor: c.actor, focus: c.focus }));
  const broadcast = (event: string, data: unknown) => {
    for (const c of clients) c.send(event, data);
  };

  wp.onEvents((events) => {
    const out = events.filter((e) => !NOT_BROADCAST.has(e.type)).map(streamEvent);
    if (out.length) broadcast('events', out);
  });

  app.get('/api/stream', (req, reply) => {
    const q = req.query as { actor?: string; focus?: string };
    const actor = wp.actor(q.actor);
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const client: Client = {
      actor: actor.id,
      focus: q.focus,
      send: (event, data) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
    };
    clients.add(client);
    client.send('hello', { seq: wp.state.seq });
    broadcast('presence', presence());
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25000);
    req.raw.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
      broadcast('presence', presence());
    });
  });

  // The acting user comes from X-Actor like every other route, never from the body (D-09).
  app.post('/api/presence', async (req) => {
    const actor = wp.actor(req.headers['x-actor'] as string | undefined);
    const b = (req.body ?? {}) as { focus?: string };
    for (const c of clients) if (c.actor === actor.id) c.focus = typeof b.focus === 'string' ? b.focus : undefined;
    broadcast('presence', presence());
    return { ok: true };
  });
}
