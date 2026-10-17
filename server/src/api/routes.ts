// REST API (design §5). The acting user comes from the X-Actor header (D-09);
// every write goes through policy checks and lands as events.

import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Actor, DispositionStatus, JudgmentKind, WhoAmI } from '@easetax/shared';
import { estimateEffect, nodeKind, parseLineId } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';
import { assertCan, assertStarted, clientMayCall, PolicyError } from '../policy/policy.ts';
import { pendingJudgments } from '../judgments/pending.ts';

const STATUS: Record<PolicyError['code'], number> = { forbidden: 403, policy: 422, invalid: 400, conflict: 409, not_found: 404 };

const DISPOSITIONS: Record<DispositionStatus, string> = {
  used: 'used',
  duplicate: 'duplicate',
  superseded: 'superseded',
  not_relevant: 'not relevant',
  out_of_year: 'out of year',
  pending: 'pending',
  outside_scope: 'outside scope',
};
const JUDGMENT_KINDS: Record<JudgmentKind, string> = { judgment: 'judgment', election: 'election', due_diligence: 'due diligence', penalty: 'penalty' };
const NOTE_ACTIONS = ['reply', 'resolve', 'reopen'] as const;
/** EventSource and plain links can't send X-Actor, so these name the actor in ?actor= instead. */
const QUERY_ACTOR = [/^\/api\/stream$/, /^\/api\/attachments\/[^/]+\/file$/];
const oneOf = (label: string, allowed: Record<string, string>) => `${label} must be one of: ${Object.values(allowed).join(', ')}`;

export function registerRoutes(app: FastifyInstance, wp: Workpaper) {
  // No silent default: every request must say who is acting (D-09).
  const who = (req: FastifyRequest): Actor => wp.actor(req.headers['x-actor'] as string | undefined);
  const ok = (events: { seq: number; id: string; batchId?: string }[], data?: unknown) => ({
    ok: true as const,
    seq: events.at(-1)?.seq ?? wp.state.seq,
    batchId: events.find((e) => e.batchId)?.batchId,
    eventIds: events.map((e) => e.id),
    data,
  });

  const queryActor = (req: FastifyRequest): Actor => wp.actor(((req.query as { actor?: string }).actor ?? req.headers['x-actor']) as string | undefined);

  // Every API request names a known actor (D-09); clients reach only the portal's routes (D-35).
  // The SSE stream and file links name the actor in the query string; the stream is staff-only.
  // Staff whose start date is still ahead may only load the session, so the role switcher can say why.
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0]!;
    if (!path.startsWith('/api/')) return;
    const a = QUERY_ACTOR.some((re) => re.test(path)) ? queryActor(req) : who(req);
    if (!(req.method === 'GET' && path === '/api/me')) assertStarted(a);
    if (path === '/api/stream' && a.kind !== 'staff') throw new PolicyError('The live stream is for firm staff', 'forbidden');
    if (a.kind === 'client' && !clientMayCall(req.method, path)) throw new PolicyError('This is part of the firm workpaper', 'forbidden');
  });

  app.setErrorHandler((err, _req, reply: FastifyReply) => {
    if (err instanceof PolicyError) return reply.status(STATUS[err.code]).send({ ok: false, error: err.message, code: err.code, rule: err.rule, details: err.details });
    const status = (err as any).statusCode ?? 500;
    return reply.status(status).send({ ok: false, error: (err as Error).message, code: status === 400 ? 'invalid' : 'internal' });
  });

  // ------------------------------------------------------------ session
  app.get('/api/me', async (req): Promise<WhoAmI> => ({
    actor: who(req),
    actors: wp.actors,
    clock: { at: null, timeline: wp.b.timeline.map((t) => ({ id: t.id, at: t.at, event: t.event })) },
  }));

  // ------------------------------------------------------------ return & graph
  app.get('/api/summary', async () => wp.summary());
  app.get('/api/areas', async () => wp.areas());
  app.get('/api/lines', async (req) => {
    const q = req.query as { version?: string; area?: string; form?: string };
    return wp.lines(q);
  });
  app.get('/api/nodes/:id', async (req) => {
    const id = decodeURIComponent((req.params as any).id);
    wp.assertNode(id);
    return wp.nodeDetail(id, who(req));
  });
  app.get('/api/nodes/:id/trace', async (req) => {
    const id = decodeURIComponent((req.params as any).id);
    const q = req.query as { dir?: 'down' | 'up'; depth?: string };
    wp.assertNode(id);
    return wp.trace(id, q.dir === 'up' ? 'up' : 'down', Math.min(Number(q.depth ?? 3), 12));
  });
  app.get('/api/versions/compare', async (req) => {
    const q = req.query as { a?: string; b?: string };
    const a = q.a ?? 'v2';
    const b = q.b ?? wp.version;
    const la = new Map(wp.lines({ version: a }).map((l) => [l.key, l]));
    const lb = new Map(wp.lines({ version: b }).map((l) => [l.key, l]));
    const keys = new Set([...la.keys(), ...lb.keys()]);
    const diffs = [];
    for (const k of keys) {
      const x = la.get(k);
      const y = lb.get(k);
      const xv = x?.value;
      const yv = b === wp.version ? y?.effectiveValue : y?.value;
      if (JSON.stringify(xv) !== JSON.stringify(yv)) {
        const adj = b === wp.version && y ? wp.state.effectiveAdjustment(y.id) : undefined;
        diffs.push({
          key: k,
          label: (y ?? x)!.label,
          a: xv,
          b: yv,
          // The engine's own value for b, so an adjusted row shows engine and workpaper side by side.
          bEngine: y?.value,
          change: !x ? 'added' : !y ? 'removed' : 'changed',
          adjusted: y?.adjusted ?? false,
          adjustmentReason: adj?.reason,
          adjustedBy: adj?.by,
        });
      }
    }
    // Every engine run between a (exclusive) and b (inclusive), each with its trigger and changes.
    const order = wp.b.versions.map((v) => v.version);
    const [ia, ib] = [order.indexOf(a), order.indexOf(b)];
    const engineSteps = wp.b.versions
      .filter((_, i) => i > Math.min(ia, ib) && i <= Math.max(ia, ib))
      .map((v) => ({ version: v.version, trigger: v.trigger, computedAt: v.computed_at, changes: v.changes_from_previous }));
    return { a, b, diffs, engineSteps, engineChanges: engineSteps.flatMap((s) => s.changes) };
  });
  app.get('/api/search', async (req) => {
    const q = String((req.query as any).q ?? '').toLowerCase().trim();
    if (q.length < 2) return [];
    const out: unknown[] = [];
    for (const l of wp.b.version(wp.version)!.lines) if (l.key.toLowerCase().includes(q) || l.label.toLowerCase().includes(q)) out.push(wp.summarize(`line:${wp.version}:${l.key}`));
    for (const d of wp.b.packet.documents) if (`${d.id} ${d.title} ${d.issuer} ${d.document_type}`.toLowerCase().includes(q)) out.push(wp.summarize(`doc:${d.id}`));
    return out.slice(0, 50);
  });

  // ------------------------------------------------------------ documents & evidence
  app.get('/api/documents', async (req) => wp.documents((req.query as any).asOf));
  app.get('/api/documents/:id', async (req) => wp.documentDetail((req.params as any).id));
  app.put('/api/documents/:id/disposition', async (req) => {
    const a = who(req);
    assertCan(a, 'disposition');
    const body = (req.body ?? {}) as { status: DispositionStatus; note?: string };
    if (!wp.b.docs.has((req.params as any).id)) throw new PolicyError('No such document', 'not_found');
    if (!Object.hasOwn(DISPOSITIONS, body.status)) throw new PolicyError(oneOf('Status', DISPOSITIONS), 'invalid');
    if (!body.note?.trim() && body.status !== 'used') throw new PolicyError('Say why this document was not used', 'invalid');
    return ok(wp.commit(a, [{ type: 'disposition.set', payload: { documentId: (req.params as any).id, status: body.status, note: body.note } }]));
  });
  app.post('/api/attachments', async (req) => {
    const a = who(req);
    assertCan(a, 'attach');
    const id = randomUUID();
    if (req.isMultipart()) {
      const file = await req.file();
      if (!file) throw new PolicyError('No file', 'invalid');
      const buf = await file.toBuffer();
      const sha256 = createHash('sha256').update(buf).digest('hex');
      wp.store.putAttachment({ id, name: file.filename, mime: file.mimetype, size: buf.length, sha256, data: buf });
      return ok(wp.commit(a, [{ type: 'attachment.added', payload: { attachmentId: id, kind: 'file', name: file.filename, mime: file.mimetype, size: buf.length, sha256 } }]), { id: `att:${id}` });
    }
    const body = req.body as { kind: 'note' | 'message' | 'link'; name: string; text: string };
    return ok(wp.commit(a, [{ type: 'attachment.added', payload: { attachmentId: id, kind: body.kind ?? 'note', name: body.name, text: body.text } }]), { id: `att:${id}` });
  });
  app.get('/api/attachments/:id/file', async (req, reply) => {
    const a = queryActor(req);
    const f = wp.store.getAttachment((req.params as any).id);
    if (!f) throw new PolicyError('No such file', 'not_found');
    // Opening an uploaded file lands in the access log, like an unmasked view.
    wp.commit(a, [{ type: 'attachment.opened', payload: { attachmentId: (req.params as any).id, name: f.name } }]);
    reply.header('content-type', f.mime ?? 'application/octet-stream');
    reply.header('content-disposition', `inline; filename="${f.name.replace(/["\r\n]/g, '_')}"`);
    return Buffer.from(f.data);
  });
  app.post('/api/nodes/:id/evidence', async (req) => {
    const a = who(req);
    assertCan(a, 'attach');
    const nodeId = decodeURIComponent((req.params as any).id);
    const body = req.body as { evidenceId: string; note?: string };
    wp.assertNode(nodeId);
    wp.assertNode(body.evidenceId);
    return ok(wp.commit(a, [{ type: 'evidence.linked', payload: { nodeId, evidenceId: body.evidenceId, note: body.note } }]));
  });
  app.post('/api/links', async (req) => {
    const a = who(req);
    assertCan(a, 'attach');
    const b = req.body as { from: string; to: string; linkType: string; note?: string };
    wp.assertNode(b.from);
    wp.assertNode(b.to);
    return ok(wp.commit(a, [{ type: 'link.created', payload: { linkId: randomUUID(), ...b } }]));
  });

  // ------------------------------------------------------------ work actions
  app.post('/api/verifications', async (req) => {
    const b = req.body as { nodeIds: string[]; type: string; note?: string; evidence?: string[]; expected?: Record<string, number> };
    return ok(wp.verify(who(req), b.nodeIds, b.type, b.note, b.evidence, b.expected ?? {}));
  });
  app.delete('/api/verifications/:id', async (req) => {
    const a = who(req);
    assertCan(a, 'verify');
    const v = wp.state.verifications.get((req.params as any).id);
    if (!v) throw new PolicyError('No such verification', 'not_found');
    // Only the person who verified, or a reviewer or partner, takes a verification away, and says why.
    if (v.by !== a.id && a.role !== 'reviewer' && a.role !== 'partner') throw new PolicyError('Only the person who verified this, a reviewer or a partner can remove it', 'forbidden');
    const reason = String((req.body as { reason?: string } | undefined)?.reason ?? (req.query as { reason?: string }).reason ?? '').trim();
    if (!reason) throw new PolicyError('Say why the verification is being removed', 'invalid');
    return ok(wp.commit(a, [{ type: 'verification.removed', payload: { verificationId: v.id }, reason }]));
  });
  app.post('/api/adjustments', async (req) => {
    const b = req.body as { nodeId: string; newValue: unknown; reason: string; authority?: string; revision?: number };
    return ok(wp.proposeAdjustment(who(req), b.nodeId, b.newValue, b.reason, b.authority, b.revision));
  });
  app.post('/api/adjustments/:id/:decision', async (req) => {
    const { id, decision } = req.params as { id: string; decision: 'approve' | 'reject' | 'revert' };
    if (!['approve', 'reject', 'revert'].includes(decision)) throw new PolicyError('Bad decision', 'invalid');
    return ok(wp.decideAdjustment(who(req), id, decision, (req.body as any)?.note));
  });
  app.get('/api/adjustments', async (req) => {
    const status = (req.query as { status?: string }).status;
    return [...wp.state.adjustments.values()].filter((a) => !status || a.status === status);
  });
  // What-ifs: the engine's precomputed alternatives, plus ad-hoc rate-based scenarios that never touch the return.
  app.get('/api/what-ifs', async () => wp.b.packet.what_if);
  app.post('/api/what-ifs/scenario', async (req) => {
    const b = req.body as { changes: { nodeId: string; newValue: number }[] };
    const v = wp.b.version(wp.version)!;
    const rows = (b.changes ?? []).map((c) => {
      const p = parseLineId(c.nodeId);
      if (!p || p.version !== wp.version) throw new PolicyError(`Scenario lines must be in ${wp.version}`, 'invalid');
      const current = wp.lineValue(p.key);
      return { nodeId: c.nodeId, label: wp.b.line(p.version, p.key)?.label, current, newValue: c.newValue, effect: estimateEffect(p.key, current, c.newValue, v.tax_effect_rates, wp.version) };
    });
    const total = rows.reduce(
      (t, r) => ({ federalTax: t.federalTax + r.effect.federalTax, californiaTax: t.californiaTax + r.effect.californiaTax, federalBalance: t.federalBalance + r.effect.federalBalance, californiaBalance: t.californiaBalance + r.effect.californiaBalance }),
      { federalTax: 0, californiaTax: 0, federalBalance: 0, californiaBalance: 0 },
    );
    return { base: v.summary, rows, total, estimated: true };
  });
  // Correct what the pipeline read (D-38). The original stays; who, why and when are recorded.
  app.post('/api/reads/corrections', async (req) => {
    const b = req.body as { evId: string; value: unknown; reason: string; revision?: number };
    return ok(wp.correctRead(who(req), b.evId, b.value, b.reason, b.revision));
  });
  app.post('/api/reads/corrections/:id/revert', async (req) => ok(wp.revertCorrection(who(req), (req.params as any).id, (req.body as any)?.reason)));
  // Correct client-entered household data, citing the client's confirmation (D-47).
  app.post('/api/household/corrections', async (req) => {
    const b = req.body as { personId: string; field: string; value: unknown; evidenceId: string; reason: string; revision?: number };
    return ok(wp.correctHousehold(who(req), b.personId, b.field, b.value, b.evidenceId, b.reason, b.revision));
  });
  app.post('/api/household/corrections/:id/revert', async (req) => ok(wp.revertHouseholdCorrection(who(req), (req.params as any).id, (req.body as any)?.reason)));
  app.post('/api/undo', async (req) => ok(wp.undo(who(req), req.body as { batchId?: string; eventId?: string })));

  app.get('/api/issues', async () => wp.issues());
  app.post('/api/issues', async (req) => {
    const a = who(req);
    assertCan(a, 'note');
    const b = req.body as { nodeIds: string[]; title: string; detail?: string; severity?: 'info' | 'warning' | 'error' };
    return ok(wp.commit(a, [{ type: 'issue.raised', payload: { issueId: `hum:${randomUUID()}`, nodeIds: b.nodeIds, title: b.title, detail: b.detail, severity: b.severity ?? 'warning' } }]));
  });
  app.post('/api/issues/resolve', async (req) => {
    const a = who(req);
    assertCan(a, 'resolve_issue');
    const b = req.body as { issueIds: string[]; status: 'resolved' | 'accepted'; resolution: string };
    if (!b.resolution?.trim()) throw new PolicyError('Resolution needs an explanation', 'invalid');
    // D-65: a reason a reviewer can act on, not a placeholder like "123".
    const words = b.resolution.trim().split(/\s+/).filter((w) => /[a-z]/i.test(w));
    if (words.length < 3 || b.resolution.trim().length < 15) throw new PolicyError('Say why in a sentence (at least 3 words) so a reviewer can check it.', 'invalid');
    const batchId = b.issueIds.length > 1 ? randomUUID() : undefined;
    return ok(wp.commit(a, b.issueIds.map((issueId) => ({ type: 'issue.resolved' as const, payload: { issueId, status: b.status, resolution: b.resolution }, batchId }))));
  });
  app.post('/api/issues/:id/reopen', async (req) => {
    const a = who(req);
    assertCan(a, 'resolve_issue');
    const reason = (req.body as { reason?: string } | undefined)?.reason?.trim() || undefined;
    return ok(wp.commit(a, [{ type: 'issue.reopened', payload: { issueId: decodeURIComponent((req.params as any).id) }, reason }]));
  });
  app.post('/api/issues/:id/confirm', async (req) => ok(wp.confirmIssueClosure(who(req), decodeURIComponent((req.params as any).id))));
  app.get('/api/my-actions', async (req) => wp.myActions(who(req)));

  app.post('/api/judgments', async (req) => {
    const a = who(req);
    assertCan(a, 'judgment');
    const b = (req.body ?? {}) as { kind: JudgmentKind; topic: string; decision: string; alternatives?: string[]; authority: string; nodeIds?: string[]; issueIds?: string[] };
    if (!Object.hasOwn(JUDGMENT_KINDS, b.kind)) throw new PolicyError(oneOf('Kind', JUDGMENT_KINDS), 'invalid');
    if (!b.authority?.trim()) throw new PolicyError('Every judgment call records the authority relied on.', 'policy', 'Every judgment call records the authority relied on.');
    const known = new Set(wp.issues().map((i) => i.id));
    const unknown = (b.issueIds ?? []).filter((id) => !known.has(id));
    if (unknown.length) throw new PolicyError(`No such issue: ${unknown.join(', ')}`, 'invalid');
    return ok(
      wp.commit(a, [
        {
          type: 'judgment.recorded',
          payload: { judgmentId: randomUUID(), kind: b.kind, topic: b.topic, decision: b.decision, alternatives: b.alternatives ?? [], authority: b.authority, nodeIds: b.nodeIds ?? [], issueIds: b.issueIds ?? [] },
        },
      ]),
    );
  });
  app.get('/api/judgments', async () => [...wp.state.judgments.values()]);
  app.get('/api/judgments/pending', async () => pendingJudgments(wp));

  app.put('/api/areas/:id/considered', async (req) => {
    const a = who(req);
    assertCan(a, 'signoff');
    return ok(wp.commit(a, [{ type: 'area.considered', payload: { areaId: (req.params as any).id, note: (req.body as any)?.note } }]));
  });
  app.post('/api/variances/explain', async (req) => {
    const a = who(req);
    assertCan(a, 'verify');
    const b = (req.body ?? {}) as { nodeId: string; explanation: string };
    if (typeof b.nodeId !== 'string') throw new PolicyError('Say which line the explanation is for', 'invalid');
    if (!wp.g.nodes.has(b.nodeId)) throw new PolicyError(`Unknown line ${b.nodeId}`, 'not_found');
    if (typeof b.explanation !== 'string' || !b.explanation.trim()) throw new PolicyError('Explain the variance in a sentence', 'invalid');
    return ok(wp.commit(a, [{ type: 'variance.explained', payload: { nodeId: b.nodeId, explanation: b.explanation.trim() } }]));
  });

  // ------------------------------------------------------------ people & workflow
  app.post('/api/notes', async (req) => {
    const a = who(req);
    assertCan(a, 'note');
    const b = req.body as { nodeIds: string[]; text: string; blocking?: boolean };
    return ok(wp.commit(a, [{ type: 'note.created', payload: { noteId: randomUUID(), nodeIds: b.nodeIds, text: b.text, blocking: !!b.blocking } }]));
  });
  app.get('/api/notes', async () => [...wp.state.notes.values()].map((n) => wp.publicNote(n)));
  app.post('/api/notes/:id/:action', async (req) => {
    const a = who(req);
    assertCan(a, 'note');
    const { id, action } = req.params as { id: string; action: (typeof NOTE_ACTIONS)[number] };
    if (!NOTE_ACTIONS.includes(action)) throw new PolicyError(`Unknown note action "${action}": use reply, resolve or reopen`, 'invalid');
    const note = wp.state.notes.get(id);
    if (!note) throw new PolicyError('No such note', 'not_found');
    if (action === 'reply') return ok(wp.commit(a, [{ type: 'note.replied', payload: { noteId: id, text: (req.body as any).text } }]));
    // Only the note's author (the reviewer) clears a blocking note.
    if (action === 'resolve' && note.blocking && note.by !== a.id && a.role !== 'partner') {
      throw new PolicyError('Only the author or a partner can clear a blocking review note', 'forbidden');
    }
    return ok(wp.commit(a, [{ type: action === 'resolve' ? 'note.resolved' : 'note.reopened', payload: { noteId: id } }]));
  });

  app.post('/api/questions', async (req) => {
    const a = who(req);
    assertCan(a, 'ask');
    const b = req.body as { to: string; nodeIds: string[]; text: string };
    return ok(wp.commit(a, [{ type: 'question.asked', payload: { questionId: randomUUID(), to: b.to, nodeIds: b.nodeIds, text: b.text } }]));
  });
  app.get('/api/questions', async (req) => {
    const a = who(req);
    const all = [...wp.state.questions.values()];
    return (a.kind === 'client' ? all.filter((q) => q.to === 'client') : all).map((q) => wp.publicQuestion(q));
  });
  app.post('/api/questions/:id/answer', async (req) => {
    const a = who(req);
    assertCan(a, 'answer_client_question');
    const q = wp.state.questions.get((req.params as any).id);
    if (!q) throw new PolicyError('No such question', 'not_found');
    if (a.kind === 'client' && q.to !== 'client') throw new PolicyError('Not addressed to you', 'forbidden');
    if (a.kind === 'staff' && q.to !== a.id && q.to !== 'client') throw new PolicyError('Not addressed to you', 'forbidden');
    return ok(wp.commit(a, [{ type: 'question.answered', payload: { questionId: q.id, text: (req.body as any).text } }]));
  });

  app.post('/api/signoffs', async (req) => {
    const b = req.body as { scope: string; level: 'preparer' | 'reviewer' | 'partner' };
    return ok(wp.signoff(who(req), b.scope, b.level));
  });
  app.get('/api/signoffs', async () => [...wp.state.signoffs.values()]);

  app.post('/api/assignments', async (req) => {
    const a = who(req);
    assertCan(a, 'assign');
    const b = req.body as { scope: string; assignee: string; due?: string; text: string };
    return ok(wp.commit(a, [{ type: 'assignment.created', payload: { assignmentId: randomUUID(), ...b } }]));
  });
  app.get('/api/assignments', async () => [...wp.state.assignments.values()]);
  app.post('/api/assignments/:id/complete', async (req) => {
    const a = who(req);
    const asg = wp.state.assignments.get((req.params as any).id);
    if (!asg) throw new PolicyError('No such assignment', 'not_found');
    if (asg.assignee !== a.id) assertCan(a, 'assign');
    return ok(wp.commit(a, [{ type: 'assignment.completed', payload: { assignmentId: asg.id } }]));
  });
  app.get('/api/firm/dashboard', async (req) => {
    const a = who(req);
    if (a.kind === 'client') throw new PolicyError('Firm staff only', 'forbidden');
    const f = wp.b.packet.firm;
    const s = wp.summary();
    return {
      deadlines: f.deadlines,
      assignmentAtStart: f.assignment_at_start,
      budget: wp.budgetLines(),
      status: s.status,
      openAssignments: [...wp.state.assignments.values()].filter((x) => !x.done),
    };
  });
  app.get('/api/notices', async (req) => {
    const a = who(req);
    if (a.kind === 'client') throw new PolicyError('Firm staff only', 'forbidden');
    return wp.b.packet.tax_agency_records.notices ?? [];
  });
  app.post('/api/time', async (req) => {
    const a = who(req);
    assertCan(a, 'log_time');
    const b = req.body as { area: string; hours: number; note?: string };
    if (!(b.hours > 0 && b.hours <= 24)) throw new PolicyError('Hours must be between 0 and 24', 'invalid');
    if (!wp.budgetLines().some((l) => l.area === b.area)) throw new PolicyError(`Unknown budget line ${b.area}`, 'invalid');
    return ok(wp.commit(a, [{ type: 'time.logged', payload: b }]));
  });

  app.get('/api/changes/since-last-seen', async (req) => {
    const a = who(req);
    const since = wp.state.lastSeen.get(a.id) ?? 0;
    return { since, events: wp.state.events.filter((e) => e.seq > since && e.actor !== a.id && !QUIET_EVENTS.has(e.type)).map((e) => wp.publicEvent(e)) };
  });
  app.post('/api/changes/mark-seen', async (req) => {
    const a = who(req);
    // Mark only what the client actually saw, so events that arrived meanwhile stay unread.
    const seen = Number((req.body as { seq?: number } | undefined)?.seq);
    const seq = Number.isFinite(seen) && seen > 0 ? Math.min(seen, wp.state.seq) : wp.state.seq;
    return ok(wp.commit(a, [{ type: 'seen.marked', payload: { seq } }]));
  });
  app.get('/api/events', async (req) => {
    const after = Number((req.query as any).after ?? 0);
    return wp.state.events.filter((e) => e.seq > after).map((e) => wp.publicEvent(e));
  });

  // ------------------------------------------------------------ sensitive data
  app.post('/api/sensitive/unmask', async (req) => {
    const a = who(req);
    assertCan(a, 'unmask');
    const b = req.body as { nodeId: string; field: string; reason: string };
    if (!a.clearance) throw new PolicyError('No sensitive-data clearance', 'forbidden', 'Staff without sensitive-data clearance see SSNs, bank and account numbers and IP PINs masked; every unmasked view is logged.');
    if (!b.reason?.trim()) throw new PolicyError('Give a reason to view sensitive data', 'invalid');
    const value = unmaskedField(wp, b.nodeId, b.field);
    const events = wp.commit(a, [{ type: 'sensitive.unmasked', payload: { nodeId: b.nodeId, field: b.field }, reason: b.reason }]);
    return ok(events, { value });
  });
  app.get('/api/firm/access-log', async (req) => {
    const a = who(req);
    assertCan(a, 'standards');
    // Unmasked views, plus every opened uploaded file (field "file").
    const opened = wp.state.events
      .filter((e) => e.type === 'attachment.opened')
      .map((e) => ({ actor: e.actor, nodeId: `att:${(e.payload as { attachmentId: string }).attachmentId}`, field: 'file', reason: undefined as string | undefined, at: e.at }));
    return [...wp.state.accessLog, ...opened].sort((x, y) => x.at.localeCompare(y.at));
  });
  app.get('/api/firm/standards', async () => wp.standards());
  app.put('/api/firm/standards', async (req) => {
    const a = who(req);
    assertCan(a, 'standards');
    return ok(wp.commit(a, [{ type: 'firm.standards_updated', payload: { standards: req.body } }]));
  });
}

/** Bookkeeping kept out of "since I last looked". */
const QUIET_EVENTS = new Set<string>(['seen.marked', 'notification.read', 'attachment.opened']);

function unmaskedField(wp: Workpaper, nodeId: string, field: string): unknown {
  const kind = nodeKind(nodeId);
  if (kind === 'household') {
    const id = nodeId.slice(10);
    if (id === 'bank') return (wp.b.packet.household.bank_account_for_refund_or_payment as any)[field];
    return (wp.person(id) as any)?.[field];
  }
  if (kind === 'ev') return wp.b.evs.get(nodeId.slice(3))?.value;
  if (kind === 'page') {
    const [doc, page] = nodeId.slice(4).split('#page');
    return wp.b.docs.get(doc!)?.pages.find((p) => p.page === Number(page))?.printed_content;
  }
  throw new PolicyError('Nothing sensitive to unmask here', 'invalid');
}
