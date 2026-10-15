// Engine-independent checks (D-07). Each check is a pure function over the baseline,
// the graph and the current workpaper state, returning issues tied to exact nodes.
// Issue ids must be stable across runs so resolutions (events) stay attached.

import type { ExtractedValue, IssueDto, PacketPerson } from '@easetax/shared';
import { diagId, resolveRef } from '@easetax/shared';
import type { Baseline } from '../baseline/baseline.ts';
import type { Graph } from '../graph/graph.ts';
import type { WorkState } from '../state/state.ts';

export interface CheckContext {
  b: Baseline;
  g: Graph;
  state: WorkState;
  version: string;
  /** Effective value of a line in `version` after approved adjustments. */
  lineValue(key: string): unknown;
  /** An extracted value as it stands after any human read correction (original object if none). */
  effectiveEv(e: ExtractedValue): ExtractedValue;
  /** A household person as the record stands after corrections (D-47). */
  effectivePerson(p: PacketPerson): PacketPerson;
}

export type CheckIssue = Omit<IssueDto, 'status' | 'source'> & { source?: IssueDto['source'] };

export interface Check {
  id: string;
  title: string;
  /** Which family in design §7.4 this belongs to. */
  family:
    | 'read'
    | 'footing'
    | 'summary_vs_detail'
    | 'duplicate'
    | 'third_party'
    | 'prior_year'
    | 'identity'
    | 'client_vs_documents'
    | 'variance'
    | 'scope'
    | 'completeness'
    | 'recalc'
    | 'state_split'
    | 'judgment';
  run(ctx: CheckContext): CheckIssue[];
}

const registry: Check[] = [];

export function registerCheck(c: Check) {
  if (registry.some((r) => r.id === c.id)) throw new Error(`duplicate check id ${c.id}`);
  registry.push(c);
}

export function allChecks(): readonly Check[] {
  return registry;
}

/** The engine's own diagnostics, kept separate from our checks so the two can be compared. */
export function engineIssues(ctx: CheckContext): CheckIssue[] {
  const v = ctx.b.version(ctx.version);
  if (!v) return [];
  return v.diagnostics.map((d) => ({
    id: `eng:${ctx.version}:${d.code}`,
    source: 'engine' as const,
    code: d.code,
    title: d.message,
    severity: d.severity,
    nodeIds: [diagId(ctx.version, d.code), ...(d.refs ?? []).map((r) => resolveRef(r, ctx.version))],
  }));
}

export function runChecks(ctx: CheckContext): CheckIssue[] {
  const out: CheckIssue[] = [...engineIssues(ctx)];
  for (const c of registry) {
    try {
      for (const i of c.run(ctx)) out.push({ source: 'check', ...i, code: i.code || c.id });
    } catch (err) {
      out.push({
        id: `chk:${c.id}:crashed`,
        source: 'check',
        code: c.id,
        title: `Check "${c.title}" failed to run: ${(err as Error).message}`,
        severity: 'warning',
        nodeIds: [],
      });
    }
  }
  return out;
}
