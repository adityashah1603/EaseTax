// Filing and after (FR-6, design §5.6).

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Workpaper } from '../workpaper.ts';
import { assertCan, PolicyError } from '../policy/policy.ts';
import { readiness } from '../filing/readiness.ts';
import { filedSnapshotId, filingState } from '../filing/state.ts';
import { amendmentDiff, confirmRejectionFix, openAmendment, recordClientApproval, recordRejectionFix, recordExtension, recordManualStep, recordResult, submit } from '../filing/commands.ts';
import { buildNoticeCase, exportNoticeCase } from '../filing/notice.ts';
import { rollForward } from '../filing/rollforward.ts';
import { loadSnapshot } from '../filing/snapshot.ts';

export function registerFilingRoutes(app: FastifyInstance, wp: Workpaper) {
  const who = (req: FastifyRequest) => wp.actor(req.headers['x-actor'] as string | undefined);
  const ok = (events: { seq: number; id: string; batchId?: string }[], data?: unknown) => ({
    ok: true as const,
    seq: events.at(-1)?.seq ?? wp.state.seq,
    batchId: events.find((e) => e.batchId)?.batchId,
    eventIds: events.map((e) => e.id),
    data,
  });
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
    return a.kind === 'client' ? { clientApproval: st.clientApproval, approvalOpen: st.approvalOpen, submissions: st.submissions.map(({ id, jurisdiction, status, errors }) => ({ id, jurisdiction, status, errors })), filed: st.filed } : st;
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
  app.post('/api/filing/submissions/:id/fix', async (req) => ok(recordRejectionFix(wp, who(req), (req.params as { id: string }).id, (req.body ?? {}) as { note?: string; refs?: string[] })));
  app.post('/api/filing/submissions/:id/fix/confirm', async (req) => ok(confirmRejectionFix(wp, who(req), (req.params as { id: string }).id)));
  app.post('/api/filing/submissions/:id/result', async (req) => {
    const r = recordResult(wp, who(req), (req.params as { id: string }).id, (req.body ?? {}) as any);
    return ok(r.events, r.data);
  });
  // The client's copy: the filed return's lines and totals only (no workpaper state).
  app.get('/api/filing/client-copy', async () => {
    const id = filedSnapshotId(wp);
    if (!id) throw new PolicyError('Nothing has been filed yet', 'not_found');
    const s = loadSnapshot(wp, id);
    return { snapshotId: id, contentHash: s.contentHash, taxYear: s.content.taxYear, lines: s.content.lines, summary: s.content.summary, filedAt: s.meta.at };
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
