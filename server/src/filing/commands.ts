// Filing commands. Every action is a `filing.step` event; frozen content goes to snapshots.

import { createHash, randomUUID } from 'node:crypto';
import type { Actor, FrozenLine, SubmissionDto } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';
import { assertCan, PolicyError } from '../policy/policy.ts';
import { readiness } from './readiness.ts';
import { filedSnapshotId, filingState } from './state.ts';
import { freeze, loadSnapshot, type FilingSnapshotContent } from './snapshot.ts';

const step = (wp: Workpaper, actor: Actor, name: string, data: unknown, reason?: string) =>
  wp.commit(actor, [{ type: 'filing.step', payload: { step: name, data }, reason }]);

export function recordExtension(wp: Workpaper, actor: Actor, body: { federal?: number; california?: number }) {
  assertCan(actor, 'filing');
  const plan = wp.b.packet.what_if?.extension ?? {};
  const federal = body.federal ?? plan.federal?.paid_with_form_4868 ?? 0;
  const california = body.california ?? plan.california?.paid_with_ftb_3519 ?? 0;
  if (![federal, california].every((x) => typeof x === 'number' && x >= 0)) throw new PolicyError('Extension amounts must be non-negative numbers', 'invalid');
  return step(wp, actor, 'extension', { federal, california, forms: { federal: 'Form 4868', california: 'FTB 3519' }, basedOn: plan.based_on_version ?? null });
}

/**
 * Client approval and e-file authorization (Form 8879 / FTB 8879). The PINs are the signature;
 * we keep a salted hash as proof of consent and never store or echo the PIN itself.
 */
export function recordClientApproval(wp: Workpaper, actor: Actor, body: { pins?: Record<string, string>; consent?: boolean }) {
  assertCan(actor, 'client_approval');
  if (body.consent !== true) throw new PolicyError('Approval requires explicit consent to e-file', 'invalid');
  const pins = body.pins ?? {};
  if (!Object.keys(pins).length) throw new PolicyError('Provide the signer PIN(s) for Form 8879', 'invalid');
  const pinHashes: Record<string, string> = {};
  const pinsMasked: Record<string, string> = {};
  for (const [signer, pin] of Object.entries(pins)) {
    if (!/^\d{5}$/.test(String(pin))) throw new PolicyError(`PIN for ${signer} must be 5 digits`, 'invalid');
    pinHashes[signer] = createHash('sha256').update(`${wp.b.packet.packet.client_id}:${signer}:${pin}`).digest('hex');
    pinsMasked[signer] = '•••••';
  }
  const returnHash = wp.scopeHash('return');
  const events = step(wp, actor, 'client_approval', { pinHashes, pinsMasked, returnHash, forms: ['Form 8879', 'FTB 8879'] });
  return { events, data: { pins: pinsMasked, returnHash } };
}

export function recordManualStep(wp: Workpaper, actor: Actor, stepName: string, note?: string) {
  assertCan(actor, 'filing');
  if (!wp.standards().required_steps.includes(stepName)) throw new PolicyError(`Not a required step: ${stepName}`, 'invalid');
  return step(wp, actor, 'manual_step', { step: stepName, note });
}

export function submit(wp: Workpaper, actor: Actor) {
  assertCan(actor, 'filing');
  const r = readiness(wp);
  if (!r.ready) {
    const why = [...r.steps.filter((s) => !s.ok).map((s) => `${s.step}: ${s.reason ?? 'not done'}`), ...r.blockers.map((b) => b.text)];
    throw new PolicyError(`Not ready to file: ${why.join(' | ')}`, 'policy', 'Open review notes block filing.');
  }
  const st = filingState(wp);
  const pending = (['federal', 'california'] as const).filter((j) => !st.submissions.some((s) => s.jurisdiction === j && (s.status === 'accepted' || s.status === 'pending')));
  if (!pending.length) throw new PolicyError('Already submitted or accepted in both jurisdictions; open an amendment for changes', 'conflict');
  const snap = freeze(wp, 'filing');
  const n = st.submissions.length;
  const submissions = pending.map((j, i) => ({ id: `S${n + i + 1}-${j}`, jurisdiction: j }));
  const events = step(wp, actor, 'submitted', { submissions, snapshotId: snap.id, contentHash: snap.contentHash, seq: snap.seq });
  return { events, data: { snapshot: snap, submissions } };
}

export function recordResult(wp: Workpaper, actor: Actor, submissionId: string, body: { status?: SubmissionDto['status']; errors?: { code: string; message: string }[]; agencySubmissionId?: string; replay?: boolean }) {
  assertCan(actor, 'filing');
  const st = filingState(wp);
  const sub = st.submissions.find((s) => s.id === submissionId);
  if (!sub) throw new PolicyError(`No submission ${submissionId}`, 'not_found');
  if (sub.status !== 'pending') throw new PolicyError(`Submission is already ${sub.status}`, 'conflict');
  let data: Record<string, unknown>;
  if (body.replay) {
    // The packet's scripted e-file results, consumed in order per jurisdiction.
    const recs = ((wp.b.packet.tax_agency_records.efile ?? []) as any[]).map((r, i) => ({ ...r, i })).filter((r) => r.jurisdiction === sub.jurisdiction).sort((a, b) => a.date.localeCompare(b.date));
    const idx = st.submissions.filter((s) => s.jurisdiction === sub.jurisdiction).findIndex((s) => s.id === sub.id);
    const rec = recs[idx];
    if (!rec) throw new PolicyError(`No scripted e-file result #${idx + 1} for ${sub.jurisdiction}`, 'not_found');
    data = { submissionId, status: rec.status, errors: rec.errors ?? [], agencySubmissionId: rec.submission_id, source: 'replay', agencyRef: `agency:/efile/${rec.i}`, agencyDate: rec.date };
  } else {
    if (!body.status || !['accepted', 'rejected', 'not_transmitted'].includes(body.status)) throw new PolicyError('status must be accepted, rejected or not_transmitted', 'invalid');
    data = { submissionId, status: body.status, errors: body.errors ?? [], agencySubmissionId: body.agencySubmissionId, source: 'manual' };
  }
  return { events: step(wp, actor, 'submission_result', data), data };
}

export function openAmendment(wp: Workpaper, actor: Actor, body: { baseSnapshotId?: string; reason?: string }) {
  assertCan(actor, 'filing');
  const base = body.baseSnapshotId ?? filedSnapshotId(wp);
  if (!base) throw new PolicyError('Nothing filed yet: no snapshot to amend', 'conflict');
  const snap = loadSnapshot(wp, base);
  if (!body.reason?.trim()) throw new PolicyError('An amendment needs a reason', 'invalid');
  const amendmentId = randomUUID();
  const events = step(wp, actor, 'amendment_opened', { amendmentId, baseSnapshotId: base, baseSeq: snap.content.seq, baseHash: snap.contentHash, reason: body.reason }, body.reason);
  return { events, data: { amendmentId, ...amendmentDiff(wp, amendmentId) } };
}

/** Diff of the current effective return against the frozen snapshot the amendment is based on. */
export function amendmentDiff(wp: Workpaper, amendmentId: string) {
  const am = filingState(wp).amendments.find((a) => a.id === amendmentId);
  if (!am) throw new PolicyError(`No amendment ${amendmentId}`, 'not_found');
  const snap = loadSnapshot<FilingSnapshotContent>(wp, am.baseSnapshotId);
  const frozen = new Map<string, FrozenLine>(snap.content.lines.map((l) => [l.key, l]));
  const diffs: { key: string; label: string; filed: unknown; current: unknown; change: 'changed' | 'added' | 'removed'; nodeId: string }[] = [];
  const seen = new Set<string>();
  for (const l of wp.lines({})) {
    seen.add(l.key);
    const f = frozen.get(l.key);
    if (!f) diffs.push({ key: l.key, label: l.label, filed: undefined, current: l.effectiveValue, change: 'added', nodeId: l.id });
    else if (JSON.stringify(f.value) !== JSON.stringify(l.effectiveValue)) diffs.push({ key: l.key, label: l.label, filed: f.value, current: l.effectiveValue, change: 'changed', nodeId: l.id });
  }
  for (const f of frozen.values()) if (!seen.has(f.key)) diffs.push({ key: f.key, label: f.label, filed: f.value, current: undefined, change: 'removed', nodeId: `line:${snap.content.version}:${f.key}` });
  const events = wp.state.events.filter((e) => e.seq > snap.content.seq && !wp.state.undone.has(e.id) && e.type.startsWith('adjustment.'));
  return { amendment: am, base: { snapshotId: am.baseSnapshotId, seq: snap.content.seq, contentHash: snap.contentHash }, diffs, changesSinceFiling: events };
}
