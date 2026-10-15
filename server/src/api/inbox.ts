// GET /api/inbox: the calling person's notifications (assignments, mentions, questions to them,
// reopened sign-offs, approvals waiting on them). Clients may call it (CLIENT_ROUTES) and get
// only client-safe kinds. Live: every committed event invalidates web queries over SSE.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { InboxDto } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';
import { assertCan } from '../policy/policy.ts';
import { inboxFor } from '../inbox/inbox.ts';

export function registerInboxRoutes(app: FastifyInstance, wp: Workpaper) {
  const who = (req: FastifyRequest) => wp.actor(req.headers['x-actor'] as string | undefined);

  app.get('/api/inbox', async (req): Promise<InboxDto> => {
    const a = who(req);
    assertCan(a, 'read');
    return inboxFor(wp, a);
  });
}
