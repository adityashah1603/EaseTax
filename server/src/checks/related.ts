// Related returns (D-58): what we claim must agree with returns filed elsewhere.
//
// - A dependent who files their own return must have checked "someone can claim you as a
//   dependent"; otherwise both returns claim the same exemption-related benefits.
// - Each current-year K-1 amount that is carried straight to a line of this return (a single
//   K-1 source, carry rules only) must equal that line's effective value.

import { relatedReturns } from '../baseline/related.ts';
import { registerCheck, type CheckContext, type CheckIssue } from './registry.ts';

/** K-1 carry rules: the line is the K-1 amount itself (computed lines are excluded). */
const CARRY_RULES = new Set(['R-K1', 'R-INTEREST-PAYER', 'R-SCORP-BASIS']);

export interface ConsistencyResult {
  check: string;
  ok: boolean;
  detail: string;
  nodeIds: string[];
}

export function relatedConsistency(ctx: CheckContext): Map<string, ConsistencyResult[]> {
  const out = new Map<string, ConsistencyResult[]>();
  const taxYear = ctx.b.packet.household.tax_year;
  for (const r of relatedReturns(ctx.b)) {
    const results: ConsistencyResult[] = [];
    const person = r.personId ? ctx.b.packet.household.people.find((p) => p.id === r.personId) : undefined;
    if (person?.role === 'dependent') {
      const claimable = /someone can claim you as a dependent/i.test(r.form);
      results.push({
        check: 'Dependent status',
        ok: claimable,
        detail: claimable
          ? `${person.name}'s own return says someone can claim them as a dependent, consistent with this return claiming them.`
          : `${person.name} files their own return without indicating they can be claimed, but this return claims them as a dependent.`,
        nodeIds: [r.id, `household:${person.id}`],
      });
    }
    for (const docIdRaw of r.docIds) {
      const d = ctx.b.docs.get(docIdRaw);
      if (!d || d.tax_year !== taxYear || !/^K-1/.test(d.document_type)) continue;
      for (const raw of ctx.b.evsByDoc.get(docIdRaw) ?? []) {
        const e = ctx.effectiveEv(raw);
        if (typeof e.value !== 'number') continue;
        for (const p of ctx.g.parents(`ev:${e.id}`)) {
          if (p.type !== 'sourced_from' || !p.to.startsWith(`line:${ctx.version}:`)) continue;
          const key = p.to.slice(`line:${ctx.version}:`.length);
          const line = ctx.b.line(ctx.version, key);
          if (!line || !CARRY_RULES.has(line.rule) || line.inputs.length || line.sources.length !== 1) continue;
          const v = ctx.lineValue(key);
          const ok = typeof v === 'number' && Math.abs(v - e.value) < 0.5;
          results.push({
            check: `K-1 ${e.field} → ${key}`,
            ok,
            detail: ok ? `${d.id} ${e.label} ${e.value} = ${key} ${v}` : `${d.id} ${e.label} is ${e.value} but ${key} carries ${String(v)}`,
            nodeIds: [r.id, `ev:${e.id}`, p.to],
          });
        }
      }
    }
    out.set(r.id, results);
  }
  return out;
}

registerCheck({
  id: 'related.consistency',
  title: 'Related returns agree with this return',
  family: 'related',
  run(ctx) {
    const issues: CheckIssue[] = [];
    for (const [id, results] of relatedConsistency(ctx)) {
      for (const r of results.filter((x) => !x.ok)) {
        issues.push({
          id: `chk:related.consistency:${id.slice(8)}:${r.check}`,
          code: r.check === 'Dependent status' ? 'RELATED_DEPENDENT_CONFLICT' : 'K1_RETURN_MISMATCH',
          title: r.detail,
          severity: 'error',
          nodeIds: r.nodeIds,
        });
      }
    }
    return issues;
  },
});
