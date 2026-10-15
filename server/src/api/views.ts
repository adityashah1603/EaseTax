// Generated views (FR-8): GET /api/views and GET /api/views/:id.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Workpaper } from '../workpaper.ts';
import { assertCan, PolicyError } from '../policy/policy.ts';
import { buildView, listViews } from '../views/index.ts';

export function registerViewRoutes(app: FastifyInstance, wp: Workpaper) {
  const who = (req: FastifyRequest) => wp.actor((req.headers['x-actor'] as string) || 'st-01');

  app.get('/api/views', async () => listViews());
  app.get('/api/views/:id', async (req) => {
    const a = who(req);
    assertCan(a, 'read');
    // Workpapers are firm records; the client portal sees the return summary, not workpaper views.
    if (a.kind === 'client') throw new PolicyError('Workpaper views are for firm staff', 'forbidden');
    return buildView(wp, (req.params as { id: string }).id);
  });
}
