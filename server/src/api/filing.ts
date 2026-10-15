// Filing and after (FR-6, design §5.6).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Workpaper } from '../workpaper.ts';
import { assertCan, PolicyError } from '../policy/policy.ts';
import { readiness } from '../filing/readiness.ts';
import { filingState } from '../filing/state.ts';
import { amendmentDiff, openAmendment, recordClientApproval, recordExtension, recordManualStep, recordResult, submit } from '../filing/commands.ts';
import { buildNoticeCase, exportNoticeCase } from '../filing/notice.ts';
import { rollForward } from '../filing/rollforward.ts';
import { loadSnapshot } from '../filing/snapshot.ts';

export function registerFilingRoutes(app: FastifyInstance, wp: Workpaper) {
  const who = (req: FastifyRequest) => wp.actor((req.headers['x-actor'] as string) || 'st-01');
  const ok = (events: { seq: number }[], data?: unknown) => ({ ok: true as const, seq: events.at(-1)?.seq ?? wp.state.seq, data });
  const staff = (req: FastifyRequest) => {
    const a = who(req);
    if (a.kind === 'client') throw new PolicyError('Firm staff only', 'forbidden');
    return a;
  };

  // Readiness is a read; both verbs are accepted (§5.6 lists POST).
  app.get('/api/filing/readiness', async () => readiness(wp));
  app.post('/api/filing/readiness', async () => readiness(wp));
  app.get('/api/filing/status', async (req) => {
    const a = who(req);
    const st = filingState(wp);
    // Clients see their own approval and the submission outcomes, not workpaper snapshots.
    return a.kind === 'client' ? { clientApproval: st.clientApproval, submissions: st.submissions.map(({ id, jurisdiction, status, errors }) => ({ id, jurisdiction, status, errors })), filed: st.filed } : st;
  });
  app.post('/api/filing/steps/manual', async (req) => {
    const b = req.body as { step: string; note?: string };
    return ok(recordManualStep(wp, who(req), b.step, b.note));
  });
  app.post('/api/filing/extension', async (req) => ok(recordExtension(wp, who(req), (req.body ?? {}) as { federal?: number; california?: number })));
  app.post('/api/filing/client-approval', async (req) => {
    const r = recordClientApproval(wp, who(req), (req.body ?? {}) as { pins?: Record<string, string>; consent?: boolean });
    return ok(r.events, r.data);
  });
  app.post('/api/filing/submit', async (req) => {
    const r = submit(wp, who(req));
    return ok(r.events, r.data);
  });
  app.post('/api/filing/submissions/:id/result', async (req) => {
    const r = recordResult(wp, who(req), (req.params as { id: string }).id, (req.body ?? {}) as any);
    return ok(r.events, r.data);
  });
  app.get('/api/filing/snapshots/:id', async (req) => {
    staff(req);
    const s = loadSnapshot(wp, (req.params as { id: string }).id);
    return { ...s.meta, contentHash: s.contentHash, content: s.content };
  });

  app.post('/api/amendments', async (req) => {
    const r = openAmendment(wp, who(req), (req.body ?? {}) as { baseSnapshotId?: string; reason?: string });
    return ok(r.events, r.data);
  });
  app.get('/api/amendments/:id', async (req) => {
    assertCan(staff(req), 'read');
    return amendmentDiff(wp, (req.params as { id: string }).id);
  });

  app.post('/api/notices/:noticeId/case', async (req) => {
    const r = buildNoticeCase(wp, who(req), (req.params as { noticeId: string }).noticeId, (req.body ?? {}) as { snapshotId?: string });
    return ok(r.events, r.data);
  });
  app.get('/api/notices/:caseId/export', async (req, reply) => {
    staff(req);
    const format = ((req.query as { format?: string }).format ?? 'json') as 'json' | 'html';
    if (!['json', 'html'].includes(format)) throw new PolicyError('format must be json or html', 'invalid');
    const out = exportNoticeCase(wp, (req.params as { caseId: string }).caseId, format);
    reply.header('content-type', out.contentType);
    if (format === 'html') reply.header('content-disposition', `inline; filename="${(req.params as { caseId: string }).caseId}.html"`);
    return out.body;
  });

  app.post('/api/rollforward', async (req) => {
    const r = rollForward(wp, who(req), (req.body ?? {}) as { toYear?: number });
    return ok(r.events, r.data);
  });
}
