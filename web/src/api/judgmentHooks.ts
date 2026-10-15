// Judgment calls, elections, due diligence and penalty decisions (FR "record judgment calls"),
// the calls the engine and our checks say still need one, and which areas were considered.
// Like hooks.ts, every query is invalidated by the SSE stream, so these stay live.
import type { IssueDto, JudgmentDto, JudgmentKind, WorkEvent } from '@easetax/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from './client';
import { useEvents, useIssues, useSummary } from './hooks';

export const JUDGMENT_KINDS: JudgmentKind[] = ['judgment', 'election', 'due_diligence', 'penalty'];
export const KIND_LABEL: Record<JudgmentKind, string> = {
  judgment: 'Judgment call',
  election: 'Election',
  due_diligence: 'Due diligence',
  penalty: 'Penalty decision',
};
export const KIND_PLURAL: Record<JudgmentKind, string> = {
  judgment: 'Judgment calls',
  election: 'Elections',
  due_diligence: 'Due diligence',
  penalty: 'Penalty decisions',
};
/** The firm rule the server enforces on POST /api/judgments (quoted when it refuses). */
export const AUTHORITY_RULE = 'Every judgment call records the authority relied on.';

export const useJudgments = () => useQuery({ queryKey: ['judgments'], queryFn: () => api<JudgmentDto[]>('/api/judgments') });

/** One engine what_if alternative (packet what_if.alternatives), as served by GET /api/what-ifs. */
export interface WhatIfAlternative {
  id: string;
  description: string;
  base_version?: string;
  choices?: Record<string, string>;
  federal?: { total_tax_change?: number; penalty_change?: number; base?: { penalty?: number }; alternative?: { penalty?: number } };
  california?: { total_tax_change?: number };
  changed_lines?: { key: string; change: string; old: unknown; new: unknown }[];
}
/** Same query key as useWhatIfs (workflowHooks) so the cache is shared; this view types the alternatives. */
export const useWhatIfAlternatives = () =>
  useQuery({ queryKey: ['what-ifs'], queryFn: () => api<{ alternatives?: WhatIfAlternative[] }>('/api/what-ifs'), staleTime: Infinity });

/** A decision the return still needs someone to record, with what the dialog is prefilled with. */
export interface PendingCall {
  key: string;
  kind: JudgmentKind;
  topic: string;
  why: string;
  /** Where it came from: an open issue, the engine's what_if alternatives, or an engine diagnostic. */
  sources: { label: string; issue?: IssueDto }[];
  alternatives: string[];
  options: WhatIfAlternative[];
  nodeIds: string[];
  /** A recorded judgment of this kind touching any of these ids settles the call. */
  anchors: string[];
  authorityHint: string;
  decided: JudgmentDto[];
}

// Topic and authority hints for the choice keys the engine's what_ifs use. Unknown keys fall
// back to the alternative's own description, so a new what_if still shows up.
const CHOICE_TOPIC: Record<string, { topic: string; kind: JudgmentKind; hint: string }> = {
  equipment: { topic: 'Studio equipment: section 179, special (bonus) depreciation or regular MACRS', kind: 'election', hint: 'IRC §179; §168(k); Form 4562 instructions' },
  hvac: { topic: 'HVAC replacement: repair or capital improvement', kind: 'judgment', hint: 'Treas. Reg. §1.263(a)-3(i), (j), (k)' },
  deduction: { topic: 'Standard deduction or itemized deductions', kind: 'election', hint: 'IRC §63(e)' },
  penalty_method: { topic: 'Underpayment penalty (Form 2210): regular or annualized income method', kind: 'penalty', hint: 'IRC §6654(d)(2); Form 2210 Schedule AI' },
};
// what_ifs that change no lines (the penalty method) still need something to link to.
const CHOICE_LINES: Record<string, string[]> = { penalty_method: ['F2210.19', 'F2210.AI', 'F1040.38'] };

const signed = (n: number | undefined) => (!n ? '0' : `${n > 0 ? '+' : '−'}${Math.abs(n).toLocaleString('en-US')}`);
export function optionText(a: WhatIfAlternative) {
  const parts = [`federal tax ${signed(a.federal?.total_tax_change)}`, `California tax ${signed(a.california?.total_tax_change)}`];
  if (a.federal?.penalty_change) parts.push(`penalty ${signed(a.federal.penalty_change)}`);
  return `${a.description} (engine what_if ${a.id}: ${parts.join(', ')})`;
}

/**
 * The calls waiting for a decision, derived (no server endpoint): open issues of the
 * judgment check family (ids "chk:judgment.*"), the engine's what_if alternatives grouped by
 * the choice they flip, and the engine's DUE_DILIGENCE_REQUIRED diagnostic.
 */
export function useJudgmentCalls() {
  const issues = useIssues();
  const whatIfs = useWhatIfAlternatives();
  const judgments = useJudgments();
  const summary = useSummary();
  const calls = useMemo(() => {
    const v = summary.data?.currentVersion ?? 'v3';
    const all = judgments.data ?? [];
    const open = (issues.data ?? []).filter((i) => i.status === 'open');
    const out: PendingCall[] = [];

    const groups = new Map<string, WhatIfAlternative[]>();
    for (const a of whatIfs.data?.alternatives ?? []) {
      const k = Object.keys(a.choices ?? {}).sort().join('+') || a.id;
      groups.set(k, [...(groups.get(k) ?? []), a]);
    }
    const usedIssues = new Set<string>();
    for (const [k, opts] of groups) {
      const meta = CHOICE_TOPIC[k];
      const ver = opts[0]?.base_version ?? v;
      const changed = [...new Set(opts.flatMap((o) => (o.changed_lines ?? []).map((c) => `line:${ver}:${c.key}`)))];
      const fixed = (CHOICE_LINES[k] ?? []).map((key) => `line:${ver}:${key}`);
      const anchors = [...changed, ...fixed];
      // A judgment-family issue on the same lines is the same call: merge it in.
      const related = open.filter((i) => i.id.startsWith('chk:judgment.') && i.nodeIds.some((n) => anchors.includes(n)));
      related.forEach((i) => usedIssues.add(i.id));
      const kind = meta?.kind ?? (related.length ? 'judgment' : 'election');
      const linked = [...new Set([...related.flatMap((i) => i.nodeIds), ...fixed, ...changed.slice(0, 3)])];
      out.push({
        key: `whatif:${k}`,
        kind,
        topic: meta?.topic ?? opts[0]!.description,
        why: related.length
          ? 'Our check flagged it, and the engine computed the alternative treatment.'
          : `The engine computed ${opts.length === 1 ? 'an alternative' : `${opts.length} alternatives`}; the choice made should be on record.`,
        sources: [...related.map((i) => ({ label: i.title, issue: i })), ...opts.map((o) => ({ label: `Engine what_if ${o.id}` }))],
        alternatives: opts.map(optionText),
        options: opts,
        nodeIds: linked,
        anchors,
        authorityHint: meta?.hint ?? 'Code section, regulation, or firm policy relied on',
        decided: [],
      });
    }
    for (const i of open.filter((i) => i.id.startsWith('chk:judgment.') && !usedIssues.has(i.id)))
      out.push({
        key: `issue:${i.id}`,
        kind: 'judgment',
        topic: i.title,
        why: 'Our check flagged it as a call to make and document.',
        sources: [{ label: i.title, issue: i }],
        alternatives: i.suggestion ? [`${i.suggestion.why} (${i.suggestion.nodeId} → ${String(i.suggestion.value)})`] : [],
        options: [],
        nodeIds: i.nodeIds,
        anchors: i.nodeIds.slice(0, 1),
        authorityHint: 'Code section, regulation, or firm policy relied on',
        decided: [],
      });
    const dd = (issues.data ?? []).find((i) => i.code === 'DUE_DILIGENCE_REQUIRED');
    if (dd)
      out.push({
        key: 'due-diligence',
        kind: 'due_diligence',
        topic: 'Form 8867 due diligence: child tax credit and credit for other dependents',
        why: 'The engine requires Form 8867; filing readiness needs a due diligence record.',
        sources: [{ label: dd.title, issue: dd }],
        alternatives: [],
        options: [],
        nodeIds: dd.nodeIds,
        anchors: [],
        authorityHint: 'IRC §6695(g); Treas. Reg. §1.6695-2',
        decided: [],
      });

    for (const c of out)
      c.decided = all.filter((j) => j.kind === c.kind && (c.kind === 'due_diligence' || j.nodeIds.some((n) => c.anchors.includes(n))));
    return out;
  }, [issues.data, whatIfs.data, judgments.data, summary.data?.currentVersion]);
  return { calls, isLoading: issues.isLoading || whatIfs.isLoading || judgments.isLoading, error: issues.error ?? whatIfs.error ?? judgments.error };
}

export interface ConsideredMark {
  areaId: string;
  note?: string;
  by: string;
  at: string;
}
/**
 * Who marked each area considered and when. AreaDto only carries `considered: boolean`, so
 * fold the event log (skipping undone events), the same projection the server keeps.
 */
export function useConsideredMarks() {
  const events = useEvents();
  return useMemo(() => {
    const evs = events.data ?? [];
    const undone = new Set<string>();
    for (const e of evs) if (e.type === 'events.undone') for (const id of (e.payload as WorkEvent<'events.undone'>['payload']).eventIds) undone.add(id);
    const marks = new Map<string, ConsideredMark>();
    for (const e of evs) {
      if (e.type !== 'area.considered' || undone.has(e.id)) continue;
      const p = e.payload as WorkEvent<'area.considered'>['payload'];
      marks.set(p.areaId, { areaId: p.areaId, note: p.note, by: e.actor, at: e.at });
    }
    return marks;
  }, [events.data]);
}
