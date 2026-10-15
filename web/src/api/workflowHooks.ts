// Hooks for filing, firm administration, "since I last looked" and the replay clock.
// Like hooks.ts, every query is invalidated by the SSE stream, so these stay live.
import { useQuery } from '@tanstack/react-query';
import type { FilingStatusDto, FrozenLine, ReadinessDto, SnapshotMetaDto, WorkEvent } from '@easetax/shared';
import { useMemo } from 'react';
import { ApiFailure, api } from './client';
import { useEvents } from './hooks';

/** Filing commands answer { ok, seq, data } (no batchId/eventIds: filing steps are not undoable). */
export interface FilingResult<T = unknown> {
  ok: true;
  seq: number;
  data?: T;
}

export const useReadiness = () => useQuery({ queryKey: ['filing', 'readiness'], queryFn: () => api<ReadinessDto>('/api/filing/readiness') });
export const useFilingStatus = () => useQuery({ queryKey: ['filing', 'status'], queryFn: () => api<FilingStatusDto>('/api/filing/status') });

export interface FilingSnapshotDto extends SnapshotMetaDto {
  contentHash: string;
  content: {
    schema: string;
    kind: string;
    clientId: string;
    taxYear: number;
    version: string;
    seq: number;
    lastEventAt: string | null;
    eventLogHash: string;
    returnScopeHash: string;
    lines: FrozenLine[];
    summary: { federal: Record<string, number>; california: Record<string, number>; adjustmentEffect: Record<string, number> };
    state: { signoffs: { scope: string; level: string; by: string; at: string; status: string }[]; adjustments: unknown[] };
  };
}

/** A frozen snapshot, content-hash checked by the server on read. Snapshots never change, so cache hard. */
export const useSnapshot = (id: string | null | undefined) =>
  useQuery({ queryKey: ['snapshot', id], queryFn: () => api<FilingSnapshotDto>(`/api/filing/snapshots/${encodeURIComponent(id!)}`), enabled: !!id, staleTime: Infinity });

export interface AmendmentDiffDto {
  amendment: FilingStatusDto['amendments'][number];
  base: { snapshotId: string; seq: number; contentHash: string };
  diffs: { key: string; label: string; filed: unknown; current: unknown; change: 'changed' | 'added' | 'removed'; nodeId: string }[];
  changesSinceFiling: WorkEvent[];
}
export const useAmendment = (id: string | null) =>
  useQuery({ queryKey: ['filing', 'amendment', id], queryFn: () => api<AmendmentDiffDto>(`/api/amendments/${encodeURIComponent(id!)}`), enabled: !!id });

export interface NoticeRecord {
  id: string;
  agency: string;
  type: string;
  tax_year: number;
  dated: string;
  response_due?: string;
  document?: string;
  items_under_examination?: string[];
  summary?: string;
  status?: string;
}

export interface WhatIfs {
  extension?: { based_on_version?: string; federal?: { paid_with_form_4868?: number }; california?: { paid_with_ftb_3519?: number } };
}
export const useWhatIfs = () => useQuery({ queryKey: ['what-ifs'], queryFn: () => api<WhatIfs>('/api/what-ifs'), staleTime: Infinity });

export const useChangesSinceSeen = () =>
  useQuery({ queryKey: ['changes'], queryFn: () => api<{ since: number; events: WorkEvent[] }>('/api/changes/since-last-seen') });

export interface AccessLogRow {
  actor: string;
  nodeId: string;
  field: string;
  reason?: string;
  at: string;
}
export const useAccessLog = (enabled: boolean) =>
  useQuery({ queryKey: ['access-log'], queryFn: () => api<AccessLogRow[]>('/api/firm/access-log'), enabled });

/** Optional endpoint from design §5.7; absent today, so a 404 means "not served". */
export const useFirmDashboard = () =>
  useQuery({
    queryKey: ['firm-dashboard'],
    queryFn: async () => {
      try {
        return await api<{ deadlines?: { what: string; date: string }[] }>('/api/firm/dashboard');
      } catch (e) {
        if (e instanceof ApiFailure && e.status === 404) return null;
        throw e;
      }
    },
    retry: false,
    staleTime: 5 * 60_000,
  });

export interface Assignment {
  id: string;
  scope: string;
  assignee: string;
  due?: string;
  text: string;
  by: string;
  at: string;
  done: boolean;
  doneAt?: string;
}
export interface TimeEntry {
  id: string;
  area: string;
  hours: number;
  note?: string;
  by: string;
  at: string;
}

/**
 * Assignments and time entries. The API has no list endpoints for either, so fold the
 * event log (skipping undone events), the same projection the server keeps.
 */
export function useWorkLog() {
  const events = useEvents();
  const folded = useMemo(() => {
    const evs = events.data ?? [];
    const undone = new Set<string>();
    for (const e of evs) if (e.type === 'events.undone') for (const id of (e.payload as WorkEvent<'events.undone'>['payload']).eventIds) undone.add(id);
    const assignments = new Map<string, Assignment>();
    const time: TimeEntry[] = [];
    for (const e of evs) {
      if (undone.has(e.id)) continue;
      if (e.type === 'assignment.created') {
        const p = e.payload as WorkEvent<'assignment.created'>['payload'];
        assignments.set(p.assignmentId, { id: p.assignmentId, scope: p.scope, assignee: p.assignee, due: p.due, text: p.text, by: e.actor, at: e.at, done: false });
      } else if (e.type === 'assignment.completed') {
        const a = assignments.get((e.payload as WorkEvent<'assignment.completed'>['payload']).assignmentId);
        if (a) Object.assign(a, { done: true, doneAt: e.at });
      } else if (e.type === 'time.logged') {
        const p = e.payload as WorkEvent<'time.logged'>['payload'];
        time.push({ id: e.id, area: p.area, hours: p.hours, note: p.note, by: e.actor, at: e.at });
      }
    }
    return { assignments: [...assignments.values()], time };
  }, [events.data]);
  return { ...folded, isLoading: events.isLoading, error: events.error };
}
