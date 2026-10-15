// React Query hooks over the REST API (design §5). Every query is invalidated when the
// SSE stream reports committed events, so all screens stay live without polling.
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AreaDto,
  CommandResult,
  DocumentDetailDto,
  DocumentDto,
  IssueDto,
  LineRow,
  NodeDetail,
  NodeSummary,
  QuestionDto,
  ReturnSummaryDto,
  ReviewNoteDto,
  SignoffDto,
  TraceNode,
  WhoAmI,
  WorkEvent,
} from '@easetax/shared';
import { useMemo } from 'react';
import { api, enc } from './client';

export interface FirmStandards {
  verification_types: string[];
  variance_review: { compare_to: string; flag_if_change_over_percent: number; and_over_amount: number };
  review_levels: string[];
  rules: string[];
  required_steps: string[];
}

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<WhoAmI>('/api/me'), staleTime: 60_000 });
export const useSummary = () => useQuery({ queryKey: ['summary'], queryFn: () => api<ReturnSummaryDto>('/api/summary') });
export const useAreas = () => useQuery({ queryKey: ['areas'], queryFn: () => api<AreaDto[]>('/api/areas') });
export const useLines = (area: string | undefined) =>
  useQuery({ queryKey: ['lines', area], queryFn: () => api<LineRow[]>(`/api/lines?area=${encodeURIComponent(area!)}`), enabled: !!area });
export const useIssues = () => useQuery({ queryKey: ['issues'], queryFn: () => api<IssueDto[]>('/api/issues') });
export const useNotes = () => useQuery({ queryKey: ['notes'], queryFn: () => api<ReviewNoteDto[]>('/api/notes') });
export const useQuestions = () => useQuery({ queryKey: ['questions'], queryFn: () => api<QuestionDto[]>('/api/questions') });
export const useSignoffs = () => useQuery({ queryKey: ['signoffs'], queryFn: () => api<SignoffDto[]>('/api/signoffs') });
export const useDocuments = () => useQuery({ queryKey: ['documents'], queryFn: () => api<DocumentDto[]>('/api/documents') });
export const useDocument = (id: string | undefined) =>
  useQuery({ queryKey: ['document', id], queryFn: () => api<DocumentDetailDto>(`/api/documents/${id}`), enabled: !!id, staleTime: 30_000 });
export const useNode = (id: string | undefined | null) =>
  useQuery({ queryKey: ['node', id], queryFn: () => api<NodeDetail>(`/api/nodes/${enc(id!)}`), enabled: !!id });
export const useTrace = (id: string | undefined | null, dir: 'down' | 'up', depth = 3, enabled = true) =>
  useQuery({
    queryKey: ['trace', id, dir, depth],
    queryFn: () => api<TraceNode>(`/api/nodes/${enc(id!)}/trace?dir=${dir}&depth=${depth}`),
    enabled: !!id && enabled,
  });
export const useStandards = () => useQuery({ queryKey: ['standards'], queryFn: () => api<FirmStandards>('/api/firm/standards'), staleTime: 60_000 });
export const useEvents = () => useQuery({ queryKey: ['events'], queryFn: () => api<WorkEvent[]>('/api/events?after=0') });
export const useSearch = (q: string) =>
  useQuery({ queryKey: ['search', q], queryFn: () => api<NodeSummary[]>(`/api/search?q=${encodeURIComponent(q)}`), enabled: q.trim().length >= 2, staleTime: 30_000 });

/**
 * Line key → area id. The API has no per-line area field, so we build the index from the
 * per-area line lists (which the area screens need anyway, so the cache is shared).
 */
export function useAreaIndex() {
  const areas = useAreas();
  const results = useQueries({
    queries: (areas.data ?? []).map((a) => ({
      queryKey: ['lines', a.id],
      queryFn: () => api<LineRow[]>(`/api/lines?area=${encodeURIComponent(a.id)}`),
    })),
  });
  const ready = results.length > 0 && results.every((r) => r.data);
  const stamp = results.map((r) => r.dataUpdatedAt).join(',');
  return useMemo(() => {
    const byLineId = new Map<string, string>();
    const rowsById = new Map<string, LineRow>();
    (areas.data ?? []).forEach((a, i) => {
      for (const row of results[i]?.data ?? []) {
        byLineId.set(row.id, a.id);
        rowsById.set(row.id, row);
      }
    });
    const areaOf = (nodeIds: string[]) => {
      for (const n of nodeIds) {
        const hit = byLineId.get(n);
        if (hit) return hit;
      }
      return undefined;
    };
    return { ready, areaOf, rowsById };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [areas.data, stamp, ready]);
}

/** Pending partner approvals. No list endpoint exists, so fold the event log (see report). */
export interface PendingAdjustment {
  adjustmentId: string;
  nodeId: string;
  originalValue: unknown;
  newValue: unknown;
  by: string;
  at: string;
  reason?: string;
  effect: NonNullable<WorkEvent<'adjustment.proposed'>['payload']>['effect'];
}

export function usePendingAdjustments() {
  const events = useEvents();
  return useMemo(() => {
    const evs = events.data ?? [];
    const undone = new Set<string>();
    for (const e of evs) if (e.type === 'events.undone') for (const id of (e.payload as WorkEvent<'events.undone'>['payload']).eventIds) undone.add(id);
    const pending = new Map<string, PendingAdjustment>();
    for (const e of evs) {
      if (undone.has(e.id)) continue;
      if (e.type === 'adjustment.proposed') {
        const p = e.payload as WorkEvent<'adjustment.proposed'>['payload'];
        if (p.requiresPartner)
          pending.set(p.adjustmentId, { adjustmentId: p.adjustmentId, nodeId: p.nodeId, originalValue: p.originalValue, newValue: p.newValue, by: e.actor, at: e.at, reason: e.reason, effect: p.effect });
      } else if (e.type === 'adjustment.approved' || e.type === 'adjustment.rejected' || e.type === 'adjustment.reverted') {
        pending.delete((e.payload as { adjustmentId: string }).adjustmentId);
      }
    }
    return [...pending.values()];
  }, [events.data]);
}

/**
 * Commands answer { ok, seq } but not the batch id, which undo needs. Read back the
 * events just written to recover it (see report: the API should return batchId).
 */
export async function undoTargetFor(result: CommandResult, count: number): Promise<{ batchId?: string; eventId?: string } | null> {
  const evs = await api<WorkEvent[]>(`/api/events?after=${Math.max(0, result.seq - count)}`);
  const last = evs.find((e) => e.seq === result.seq);
  if (!last) return null;
  return last.batchId ? { batchId: last.batchId } : { eventId: last.id };
}

export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ predicate: (q) => !['me', 'standards'].includes(q.queryKey[0] as string) });
}
