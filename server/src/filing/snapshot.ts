// Freeze at filing (design §7.11): an immutable snapshot of the effective return and all
// workpaper state at one event-log position, with a SHA-256 over a canonical serialization.
// The content contains no wall-clock time, so freezing the same seq twice gives the same hash.

import { createHash, randomUUID } from 'node:crypto';
import type { FrozenLine, IssueDto } from '@easetax/shared';
import { lineId } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';
import { PolicyError } from '../policy/policy.ts';

/** JSON with object keys sorted at every level (arrays keep their order). */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface FilingSnapshotContent {
  schema: 'easetax.filing-snapshot/1';
  kind: string;
  clientId: string;
  taxYear: number;
  packetHash: string;
  version: string;
  seq: number;
  lastEventAt: string | null;
  eventLogHash: string;
  lines: FrozenLine[];
  summary: { federal: unknown; california: unknown; adjustmentEffect: unknown };
  returnScopeHash: string;
  state: {
    verifications: unknown[];
    adjustments: unknown[];
    judgments: unknown[];
    signoffs: unknown[];
    notes: unknown[];
    questions: unknown[];
    evidence: unknown[];
    links: unknown[];
    dispositions: unknown[];
    varianceExplanations: unknown[];
    reconciliations: unknown[];
    areasConsidered: unknown[];
    readCorrections?: unknown[];
    householdCorrections?: unknown[];
    issues: IssueDto[];
  };
}

const byId = <T extends { id?: string }>(xs: T[]) => [...xs].sort((a, b) => String(a.id).localeCompare(String(b.id)));
const entries = <V>(m: Map<string, V>, key: string) => [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => ({ [key]: k, ...(v as object) }));

/** The content a filing snapshot would hold at the current seq. */
export function freezeContent(wp: Workpaper, kind = 'filing'): FilingSnapshotContent {
  const s = wp.state;
  const ver = wp.b.version(wp.version)!;
  const events = s.events.filter((e) => e.seq <= s.seq);
  const log = createHash('sha256');
  for (const e of events) log.update(canonicalJson({ seq: e.seq, id: e.id, at: e.at, actor: e.actor, type: e.type, payload: e.payload, reason: e.reason ?? null }) + '\n');
  const lines: FrozenLine[] = ver.lines
    .map((l) => {
      const adj = s.effectiveAdjustment(lineId(wp.version, l.key));
      // The description as corrected (e.g. a fixed provider EIN), frozen with the return (D-47).
      return { key: l.key, form: l.form, line: l.line, label: wp.lineLabel(wp.version, l), jurisdiction: l.jurisdiction, engineValue: l.value, value: adj ? adj.newValue : l.value, adjusted: !!adj };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const summary = wp.summary();
  return {
    schema: 'easetax.filing-snapshot/1',
    kind,
    clientId: wp.b.packet.packet.client_id,
    taxYear: wp.b.packet.household.tax_year,
    packetHash: wp.b.hash,
    version: wp.version,
    seq: s.seq,
    lastEventAt: events.at(-1)?.at ?? null,
    eventLogHash: log.digest('hex'),
    lines,
    summary: { federal: ver.summary.federal, california: ver.summary.california, adjustmentEffect: summary.adjustmentEffect },
    returnScopeHash: wp.scopeHash('return'),
    state: {
      verifications: byId([...s.verifications.values()]),
      adjustments: byId([...s.adjustments.values()]),
      judgments: byId([...s.judgments.values()]),
      signoffs: byId([...s.signoffs.values()]),
      notes: byId([...s.notes.values()]),
      questions: byId([...s.questions.values()]),
      evidence: byId(s.evidence),
      links: byId(s.links),
      dispositions: wp.documents().map((d) => ({ documentId: d.id, disposition: d.disposition })),
      varianceExplanations: entries(s.varianceExplanations, 'nodeId'),
      reconciliations: entries(s.reconciliations, 'reconciliationId'),
      areasConsidered: entries(s.areaConsidered, 'areaId'),
      // Corrections in force at filing, masked like everything else that leaves the workpaper.
      readCorrections: byId([...s.activeCorrection.values()].map((id) => s.corrections.get(id)!)).map((c) => wp.nodeDetailCorrection(c)),
      householdCorrections: byId([...s.activeHousehold.values()].map((id) => s.householdCorrections.get(id)!)).map((c) => wp.publicHousehold(c)),
      issues: [...wp.issues()].sort((a, b) => a.id.localeCompare(b.id)),
    },
  };
}

export function putFrozen(wp: Workpaper, kind: string, content: unknown, id: string = randomUUID()) {
  const text = canonicalJson(content);
  const contentHash = sha256(text);
  const at = new Date().toISOString();
  wp.store.putSnapshot({ id, kind, at, seq: wp.state.seq, contentHash, content: text });
  return { id, kind, at, seq: wp.state.seq, contentHash };
}

export function freeze(wp: Workpaper, kind = 'filing') {
  return putFrozen(wp, kind, freezeContent(wp, kind));
}

/** Read a snapshot back, verifying that its content still matches its hash. */
export function loadSnapshot<T = FilingSnapshotContent>(wp: Workpaper, id: string): { content: T; contentHash: string; meta: ReturnType<Workpaper['store']['snapshots']>[number] } {
  const raw = wp.store.getSnapshot(id);
  const meta = wp.store.snapshots().find((s) => s.id === id);
  if (!raw || !meta) throw new PolicyError(`No snapshot ${id}`, 'not_found');
  if (sha256(raw.content) !== raw.contentHash) throw new PolicyError(`Snapshot ${id} fails its integrity check`, 'conflict');
  return { content: JSON.parse(raw.content) as T, contentHash: raw.contentHash, meta };
}
