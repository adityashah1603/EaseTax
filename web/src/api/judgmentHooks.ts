// Judgment calls, elections, due diligence and penalty decisions (FR "record judgment calls"),
// the calls the engine and our checks say still need one, and which areas were considered.
// Like hooks.ts, every query is invalidated by the SSE stream, so these stay live.
import type { IssueDto, JudgmentDto, JudgmentKind, PendingJudgmentDto, WorkEvent } from '@easetax/shared';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { api } from './client';
import { useEvents, useIssues } from './hooks';

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
 * The calls waiting for a decision, from GET /api/judgments/pending (D-61). The server works
 * them out; here they're joined with the issues, what_ifs and judgments the page shows.
 */
export function useJudgmentCalls() {
  const pending = useQuery({ queryKey: ['judgments', 'pending'], queryFn: () => api<PendingJudgmentDto[]>('/api/judgments/pending') });
  const issues = useIssues();
  const whatIfs = useWhatIfAlternatives();
  const judgments = useJudgments();
  const calls = useMemo<PendingCall[]>(() => {
    const byIssue = new Map((issues.data ?? []).map((i) => [i.id, i]));
    const byWhatIf = new Map((whatIfs.data?.alternatives ?? []).map((a) => [a.id, a]));
    const byJudgment = new Map((judgments.data ?? []).map((j) => [j.id, j]));
    return (pending.data ?? []).map((c) => {
      const issueList = c.issueIds.map((id) => byIssue.get(id)).filter((i): i is IssueDto => !!i);
      const options = c.whatIfIds.map((id) => byWhatIf.get(id)).filter((a): a is WhatIfAlternative => !!a);
      return {
        key: c.key,
        kind: c.kind,
        topic: c.topic,
        why: c.why,
        sources: [...issueList.map((i) => ({ label: i.title, issue: i })), ...c.whatIfIds.map((id) => ({ label: `Engine what_if ${id}` }))],
        alternatives: c.alternatives,
        options,
        nodeIds: c.nodeIds,
        anchors: [],
        authorityHint: c.authorityHint,
        decided: c.decidedIds.map((id) => byJudgment.get(id)).filter((j): j is JudgmentDto => !!j),
      };
    });
  }, [pending.data, issues.data, whatIfs.data, judgments.data]);
  return { calls, isLoading: pending.isLoading, error: pending.error ?? issues.error ?? whatIfs.error ?? judgments.error };
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
