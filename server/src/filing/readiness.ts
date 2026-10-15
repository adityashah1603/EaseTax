// Filing readiness (design §7.11): firm.starter_standards.required_steps evaluated against
// the workpaper, plus live blockers. Submit refuses unless this is clean.

import type { ReadinessDto, ReadinessStepDto } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';
import { ViewCtx } from '../views/ctx.ts';
import { variances } from '../views/summary.ts';
import { carryoverAgreement } from '../views/carryovers.ts';
import { californiaPayments, federalPayments } from '../views/payments.ts';
import { filingState } from './state.ts';

type Rule = (ctx: ViewCtx) => Omit<ReadinessStepDto, 'step' | 'kind'>;

const docNodes = (ctx: ViewCtx, docId: string) => [`doc:${docId}`, ...ctx.wp.b.docs.get(docId)!.pages.map((p) => `doc:${docId}#page${p.page}`), ...ctx.docEvs(docId).map((e) => `ev:${e.id}`)];

const RULES: [RegExp, Rule][] = [
  [
    /engagement letter|consents?/i,
    (ctx) => {
      const docs = ctx.docsOfType('engagement_letter', 'consent_7216');
      const missing = ['engagement_letter', 'consent_7216'].filter((t) => !docs.some((d) => d.document_type === t));
      const signed = docs.filter((d) => /signed/i.test(d.title + d.pages.map((p) => p.printed_content).join(' ')));
      return missing.length
        ? { ok: false, reason: `Missing: ${missing.join(', ')}` }
        : { ok: signed.length > 0, reason: signed.length ? undefined : 'Engagement letter not marked signed', nodeIds: docs.map((d) => `doc:${d.id}`) };
    },
  ],
  [
    /identity verified/i,
    (ctx) => {
      const idDocs = ctx.docsOfType('identity_document');
      const nodes = new Set(idDocs.flatMap((d) => docNodes(ctx, d.id)));
      const verified = [...ctx.verifiedNodes()].filter((n) => nodes.has(n) || n.startsWith('household:'));
      return verified.length ? { ok: true, nodeIds: verified } : { ok: false, reason: `No verification recorded on identity documents (${idDocs.map((d) => d.id).join(', ')}) or household members`, nodeIds: idDocs.map((d) => `doc:${d.id}`) };
    },
  ],
  [
    /prior.year return reviewed/i,
    (ctx) => {
      const pyDocs = ctx.docsOfType('prior_year_return');
      const nodes = new Set(pyDocs.flatMap((d) => docNodes(ctx, d.id)));
      const v = [...ctx.wp.state.verifications.values()].filter((x) => x.type === 'agreed_to_prior_year' || nodes.has(x.nodeId) || x.nodeId.startsWith('py:'));
      return v.length ? { ok: true, nodeIds: v.map((x) => x.nodeId) } : { ok: false, reason: 'No item agreed to the prior-year return yet', nodeIds: pyDocs.map((d) => `doc:${d.id}`) };
    },
  ],
  [
    /documents accounted/i,
    (ctx) => {
      const missing = ctx.wp.documents().filter((d) => !d.disposition || d.disposition.status === 'pending');
      return missing.length ? { ok: false, reason: `${missing.length} document(s) without a disposition`, nodeIds: missing.map((d) => `doc:${d.id}`) } : { ok: true };
    },
  ],
  [
    /variances explained/i,
    (ctx) => {
      const open = variances(ctx).filter((x) => x.flagged && !x.explanation);
      return open.length ? { ok: false, reason: `${open.length} flagged variance(s) without an explanation`, nodeIds: open.map((x) => x.nodeId) } : { ok: true };
    },
  ],
  [
    /carryovers agreed/i,
    (ctx) => {
      const rows = carryoverAgreement(ctx);
      const bad = rows.filter((r) => !r.agreed);
      const unverified = rows.filter((r) => r.agreed && !r.verified);
      if (bad.length) return { ok: false, reason: `Carryover lines disagree with the prior-year record: ${bad.map((r) => r.key).join(', ')}`, nodeIds: bad.map((r) => r.nodeId) };
      if (unverified.length) return { ok: false, reason: `Carryover lines agree but are not verified: ${unverified.map((r) => r.key).join(', ')}`, nodeIds: unverified.map((r) => r.nodeId) };
      return { ok: true, nodeIds: rows.map((r) => r.nodeId) };
    },
  ],
  [
    /estimated payments agreed/i,
    (ctx) => {
      const out = [federalPayments(ctx), californiaPayments(ctx)].filter((j) => !j.agreed);
      return out.length
        ? { ok: false, reason: out.map((j) => `${j.jurisdiction}: claimed ${j.claimed.toLocaleString('en-US')} vs agency ${j.record.toLocaleString('en-US')}`).join('; '), nodeIds: out.map((j) => `line:${ctx.v}:${j.line}`) }
        : { ok: true };
    },
  ],
  [
    /due diligence/i,
    (ctx) => {
      const dd = [...ctx.wp.state.judgments.values()].filter((j) => j.kind === 'due_diligence');
      return dd.length ? { ok: true, nodeIds: dd.flatMap((j) => j.nodeIds) } : { ok: false, reason: 'No due diligence judgment recorded (Form 8867)', nodeIds: ctx.has('F8867.status') ? [`line:${ctx.v}:F8867.status`] : [] };
    },
  ],
  [
    /diagnostics resolved/i,
    (ctx) => {
      const open = ctx.wp.issues().filter((i) => i.status === 'open' && (i.severity === 'error' || i.severity === 'warning'));
      return open.length ? { ok: false, reason: `${open.length} open error/warning issue(s)`, nodeIds: open.flatMap((i) => i.nodeIds.slice(0, 1)) } : { ok: true };
    },
  ],
  [/reviewer sign.?off/i, (ctx) => signoffRule(ctx, 'reviewer')],
  [/partner sign.?off/i, (ctx) => signoffRule(ctx, 'partner')],
  [
    /client approval|e-?file authori/i,
    (ctx) => {
      const ap = filingState(ctx.wp).clientApproval;
      if (!ap) return { ok: false, reason: 'Client has not approved the return or signed Form 8879' };
      return ap.current ? { ok: true } : { ok: false, reason: 'The return changed after the client approved it; approval must be renewed' };
    },
  ],
];

function signoffRule(ctx: ViewCtx, level: 'reviewer' | 'partner') {
  const all = [...ctx.wp.state.signoffs.values()].filter((s) => s.scope === 'return' && s.level === level);
  const valid = all.find((s) => s.status === 'valid');
  if (valid) return { ok: true };
  const reopened = all.find((s) => s.status === 'reopened');
  return { ok: false, reason: reopened ? `${level} sign-off on the return was reopened by a later change` : `No valid ${level} sign-off on the whole return` };
}

export function readiness(wp: Workpaper): ReadinessDto {
  const ctx = new ViewCtx(wp);
  const manual = new Set(wp.state.filingSteps.filter((s) => s.step === 'manual_step').map((s) => String((s.data as any)?.step)));
  const steps: ReadinessStepDto[] = wp.standards().required_steps.map((step) => {
    const rule = RULES.find(([re]) => re.test(step));
    if (!rule) return { step, kind: 'manual', ok: manual.has(step), reason: manual.has(step) ? undefined : 'No rule computes this step; record it as done' };
    return { step, kind: 'computed', ...rule[1](ctx) };
  });
  const blockers: ReadinessDto['blockers'] = [];
  for (const n of wp.state.notes.values())
    if (n.blocking && n.status === 'open') blockers.push({ code: 'BLOCKING_NOTE', text: `Open blocking review note: ${n.thread[0]?.text ?? ''}`, nodeIds: n.nodeIds });
  for (const a of wp.state.adjustments.values())
    if (a.status === 'proposed') blockers.push({ code: 'PENDING_PARTNER_APPROVAL', text: `Adjustment awaiting partner approval: ${a.reason}`, nodeIds: [a.nodeId] });
  return { ready: steps.every((s) => s.ok) && blockers.length === 0, seq: wp.state.seq, steps, blockers };
}
