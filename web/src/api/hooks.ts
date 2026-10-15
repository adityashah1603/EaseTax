// React Query hooks over the REST API (design §5). Every query is invalidated when the
// SSE stream reports committed events, so all screens stay live without polling.
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AdjustmentDto,
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
import { useReplayAt } from '../components/workflow/replayClock';

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
/** Documents on file. Under the replay clock (D-13) only those received by then. */
export function useDocuments() {
  const asOf = useReplayAt();
  return useQuery({ queryKey: ['documents', asOf], queryFn: () => api<DocumentDto[]>(`/api/documents${asOf ? `?asOf=${encodeURIComponent(asOf)}` : ''}`) });
}
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

/** Adjustments by status; `proposed` ones wait for a partner (the partner queue). */
export const useAdjustments = (status?: AdjustmentDto['status']) =>
  useQuery({ queryKey: ['adjustments', status ?? 'all'], queryFn: () => api<AdjustmentDto[]>(`/api/adjustments${status ? `?status=${status}` : ''}`) });

/** What POST /api/undo needs to reverse a command: its batch, else its event(s). */
export function undoTargetsFor(result: CommandResult): { batchId?: string; eventId?: string }[] {
  if (result.batchId) return [{ batchId: result.batchId }];
  return (result.eventIds ?? []).map((eventId) => ({ eventId }));
}

export function useInvalidateAll() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ predicate: (q) => !['me', 'standards'].includes(q.queryKey[0] as string) });
}
