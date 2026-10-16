// Calls waiting for a decision (D-61): open judgment-family issues, the engine's what_if
// alternatives grouped by the choice they flip, and the DUE_DILIGENCE_REQUIRED diagnostic.
// Moved from the browser so every client sees the same list and issue ids are exact.

import type { JudgmentKind, PendingJudgmentDto } from '@easetax/shared';
import type { Workpaper } from '../workpaper.ts';

interface WhatIf {
  id: string;
  description: string;
  base_version?: string;
  choices?: Record<string, string>;
  federal?: { total_tax_change?: number; penalty_change?: number };
  california?: { total_tax_change?: number };
  changed_lines?: { key: string }[];
}

// Topic, kind and authority hint per choice key; unknown keys fall back to the description.
const CHOICE: Record<string, { topic: string; kind: JudgmentKind; hint: string }> = {
  equipment: { topic: 'Studio equipment: section 179, special (bonus) depreciation or regular MACRS', kind: 'election', hint: 'IRC §179; §168(k); Form 4562 instructions' },
  hvac: { topic: 'HVAC replacement: repair or capital improvement', kind: 'judgment', hint: 'Treas. Reg. §1.263(a)-3(i), (j), (k)' },
  deduction: { topic: 'Standard deduction or itemized deductions', kind: 'election', hint: 'IRC §63(e)' },
  penalty_method: { topic: 'Underpayment penalty (Form 2210): regular or annualized income method', kind: 'penalty', hint: 'IRC §6654(d)(2); Form 2210 Schedule AI' },
};
// what_ifs that change no lines still need something to link to.
const CHOICE_LINES: Record<string, string[]> = { penalty_method: ['F2210.19', 'F2210.AI', 'F1040.38'] };
const GENERIC_HINT = 'Code section, regulation, or firm policy relied on';

const signed = (n: number | undefined) => (!n ? '0' : `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString('en-US')}`);
const optionText = (a: WhatIf) => {
  const parts = [`federal tax ${signed(a.federal?.total_tax_change)}`, `California tax ${signed(a.california?.total_tax_change)}`];
  if (a.federal?.penalty_change) parts.push(`penalty ${signed(a.federal.penalty_change)}`);
  return `${a.description} (engine what_if ${a.id}: ${parts.join(', ')})`;
};

export function pendingJudgments(wp: Workpaper): PendingJudgmentDto[] {
  const v = wp.version;
  const issues = wp.issues();
  const open = issues.filter((i) => i.status === 'open');
  const judgments = [...wp.state.judgments.values()];
  const out: (PendingJudgmentDto & { anchors: string[] })[] = [];

  const groups = new Map<string, WhatIf[]>();
  for (const a of (wp.b.packet.what_if?.alternatives ?? []) as WhatIf[]) {
    const k = Object.keys(a.choices ?? {}).sort().join('+') || a.id;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const used = new Set<string>();
  for (const [k, opts] of groups) {
    const meta = CHOICE[k];
    const ver = opts[0]?.base_version ?? v;
    const changed = [...new Set(opts.flatMap((o) => (o.changed_lines ?? []).map((c) => `line:${ver}:${c.key}`)))];
    const fixed = (CHOICE_LINES[k] ?? []).map((key) => `line:${ver}:${key}`);
    const anchors = [...changed, ...fixed];
    const related = open.filter((i) => i.id.startsWith('chk:judgment.') && i.nodeIds.some((n) => anchors.includes(n)));
    related.forEach((i) => used.add(i.id));
    out.push({
      key: `whatif:${k}`,
      kind: meta?.kind ?? (related.length ? 'judgment' : 'election'),
      topic: meta?.topic ?? opts[0]!.description,
      why: related.length
        ? 'Our check flagged it, and the engine computed the alternative treatment.'
        : `The engine computed ${opts.length === 1 ? 'an alternative' : `${opts.length} alternatives`}; the choice made should be on record.`,
      issueIds: related.map((i) => i.id),
      whatIfIds: opts.map((o) => o.id),
      alternatives: opts.map(optionText),
      nodeIds: [...new Set([...related.flatMap((i) => i.nodeIds), ...fixed, ...changed.slice(0, 3)])],
      authorityHint: meta?.hint ?? GENERIC_HINT,
      decidedIds: [],
      anchors,
    });
  }
  for (const i of open.filter((x) => x.id.startsWith('chk:judgment.') && !used.has(x.id))) {
    out.push({
      key: `issue:${i.id}`,
      kind: 'judgment',
      topic: i.title,
      why: 'Our check flagged it as a call to make and document.',
      issueIds: [i.id],
      whatIfIds: [],
      alternatives: i.suggestion ? [`${i.suggestion.why} (${i.suggestion.nodeId} → ${String(i.suggestion.value)})`] : [],
      nodeIds: i.nodeIds,
      authorityHint: GENERIC_HINT,
      decidedIds: [],
      anchors: i.nodeIds.slice(0, 1),
    });
  }
  const dd = issues.find((i) => i.code === 'DUE_DILIGENCE_REQUIRED');
  if (dd) {
    out.push({
      key: 'due-diligence',
      kind: 'due_diligence',
      topic: 'Form 8867 due diligence: child tax credit and credit for other dependents',
      why: 'The engine requires Form 8867; filing readiness needs a due diligence record.',
      issueIds: dd.status === 'open' ? [dd.id] : [],
      whatIfIds: [],
      alternatives: [],
      nodeIds: dd.nodeIds,
      authorityHint: 'IRC §6695(g); Treas. Reg. §1.6695-2',
      decidedIds: [],
      anchors: [],
    });
  }
  // Settled by a judgment of the same kind that touches the call (or closed its issue);
  // due diligence by any due-diligence judgment, as filing readiness counts it.
  return out.map(({ anchors, ...c }) => ({
    ...c,
    decidedIds: judgments
      .filter((j) => j.kind === c.kind && (c.kind === 'due_diligence' || j.nodeIds.some((n) => anchors.includes(n)) || (j.issueIds ?? []).some((id) => c.issueIds.includes(id))))
      .map((j) => j.id),
  }));
}
