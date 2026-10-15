// Server-Sent Events (D-11): every committed event is pushed to connected clients,
// plus presence (who is looking at what).

import type { FastifyInstance } from 'fastify';
import type { Workpaper } from '../workpaper.ts';

interface Client {
  actor: string;
  focus?: string;
  send: (event: string, data: unknown) => void;
}

export function registerStream(app: FastifyInstance, wp: Workpaper) {
  const clients = new Set<Client>();
  const presence = () => [...clients].map((c) => ({ actor: c.actor, focus: c.focus }));
  const broadcast = (event: string, data: unknown) => {
    for (const c of clients) c.send(event, data);
  };

  wp.onEvents((events) => broadcast('events', events.map((e) => wp.publicEvent(e)).map((e) => ({ seq: e.seq, type: e.type, actor: e.actor, at: e.at, payload: e.payload }))));

  app.get('/api/stream', (req, reply) => {
    const q = req.query as { actor?: string; focus?: string };
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const client: Client = {
      actor: q.actor ?? 'unknown',
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

  app.post('/api/presence', async (req) => {
    const b = req.body as { actor: string; focus?: string };
    for (const c of clients) if (c.actor === b.actor) c.focus = b.focus;
    broadcast('presence', presence());
    return { ok: true };
  });
}
