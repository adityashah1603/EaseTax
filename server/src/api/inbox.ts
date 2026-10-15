// GET /api/inbox: the calling person's notifications (assignments, mentions, questions to them,
// reopened sign-offs, approvals waiting on them). Clients may call it (CLIENT_ROUTES) and get
// only client-safe kinds. Live: every committed event invalidates web queries over SSE.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { InboxDto } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';
import { assertCan, PolicyError } from '../policy/policy.ts';
import { inboxFor } from '../inbox/inbox.ts';

export function registerInboxRoutes(app: FastifyInstance, wp: Workpaper) {
  const who = (req: FastifyRequest) => wp.actor(req.headers['x-actor'] as string | undefined);

  app.get('/api/inbox', async (req): Promise<InboxDto> => {
    const a = who(req);
    assertCan(a, 'read');
    return inboxFor(wp, a);
  });

  // Mark notifications read or unread (D-59). Only ids in the caller's own inbox are accepted.
  app.post('/api/inbox/read', async (req) => {
    const a = who(req);
    assertCan(a, 'read');
    const b = (req.body ?? {}) as { ids?: string[]; read?: boolean };
    const mine = new Set(inboxFor(wp, a).items.map((i) => i.id));
    const ids = (b.ids ?? []).filter((id) => mine.has(id));
    if (!ids.length) throw new PolicyError('None of those notifications are in your inbox', 'invalid');
    const [e] = wp.commit(a, [{ type: 'notification.read', payload: { ids, read: b.read !== false } }]);
    return { ok: true as const, seq: e!.seq, eventIds: [e!.id] };
  });
}
