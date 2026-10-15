// Hooks for the CPA records (generated views), version compare and what-ifs.
// All of these are reads; the SSE stream invalidates them like every other query.
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import type { EstimatedEffect, LineRow, ViewDto, ViewListItem } from '@easetax/shared';
import { api } from './client';

export const useViewList = () => useQuery({ queryKey: ['views'], queryFn: () => api<ViewListItem[]>('/api/views'), staleTime: 5 * 60_000 });

const viewQuery = (id: string) => ({ queryKey: ['view', id], queryFn: () => api<ViewDto>(`/api/views/${encodeURIComponent(id)}`), staleTime: 30_000 });
export const useView = (id: string | undefined) => useQuery({ ...viewQuery(id ?? ''), enabled: !!id });
/** Every view at once (the index shows each one's findings as its status hint). */
export const useAllViews = (ids: string[]) => useQueries({ queries: ids.map(viewQuery) });

// ------------------------------------------------------------------ compare

export interface LineDiff {
  key: string;
  label: string;
  a: unknown;
  b: unknown;
  change: 'added' | 'removed' | 'changed';
  /** b is the current version and the line carries an approved adjustment. */
  adjusted: boolean;
}
export interface EngineChange {
  key: string;
  change: 'added' | 'removed' | 'changed';
  old?: unknown;
  new?: unknown;
}
export interface CompareDto {
  a: string;
  b: string;
  diffs: LineDiff[];
  /** changes_from_previous of version b only (not every step between a and b). */
  engineChanges: EngineChange[];
}

export const useCompare = (a: string, b: string) =>
  useQuery({ queryKey: ['compare', a, b], queryFn: () => api<CompareDto>(`/api/versions/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`) });

/** The engine's own changes_from_previous for each version (read through the compare endpoint). */
export function useEngineChanges(versions: string[]) {
  const qs = useQueries({
    queries: versions.map((v) => ({
      queryKey: ['compare', 'v1', v],
      queryFn: () => api<CompareDto>(`/api/versions/compare?a=v1&b=${encodeURIComponent(v)}`),
      staleTime: 5 * 60_000,
    })),
  });
  const byVersion = new Map<string, EngineChange[]>();
  versions.forEach((v, i) => qs[i]?.data && byVersion.set(v, qs[i]!.data!.engineChanges));
  return { byVersion, ready: qs.every((q) => q.data), error: qs.find((q) => q.error)?.error };
}

export const useVersionLines = (version: string) =>
  useQuery({ queryKey: ['lines-version', version], queryFn: () => api<LineRow[]>(`/api/lines?version=${encodeURIComponent(version)}`), staleTime: 60_000 });

export interface AdjustmentDto {
  id: string;
  nodeId: string;
  originalValue: unknown;
  newValue: unknown;
  reason?: string;
  authority?: string;
  effect?: EstimatedEffect;
  status: 'proposed' | 'approved' | 'rejected' | 'reverted' | string;
  by: string;
  at: string;
}
export const useAdjustments = () => useQuery({ queryKey: ['adjustments'], queryFn: () => api<AdjustmentDto[]>('/api/adjustments') });

// ------------------------------------------------------------------ what-ifs

export interface FedTotals {
  agi: number;
  taxable_income: number;
  total_tax: number;
  payments: number;
  balance_due: number;
  penalty: number;
}
export interface CaTotals {
  total_agi: number;
  ca_agi: number;
  total_tax: number;
  payments: number;
  balance_due: number;
  penalty: number;
}
export interface WhatIfAlternative {
  id: string;
  description: string;
  base_version: string;
  choices?: Record<string, unknown>;
  federal: { base: FedTotals; alternative: FedTotals; total_tax_change: number; penalty_change?: number };
  california: { base: CaTotals; alternative: CaTotals; total_tax_change: number; penalty_change?: number };
  changed_lines: EngineChange[];
}
export interface WhatIfsDto {
  alternatives: WhatIfAlternative[];
  extension?: {
    computed_at: string;
    based_on_version: string;
    federal: Record<string, unknown>;
    california: Record<string, unknown>;
  };
}
export const useWhatIfs = () => useQuery({ queryKey: ['what-ifs'], queryFn: () => api<WhatIfsDto>('/api/what-ifs'), staleTime: 5 * 60_000 });

export interface ScenarioRow {
  nodeId: string;
  label?: string;
  current: unknown;
  newValue: number;
  effect: EstimatedEffect;
}
export interface ScenarioResult {
  base: { federal: FedTotals; california: CaTotals };
  rows: ScenarioRow[];
  total: { federalTax: number; californiaTax: number; federalBalance: number; californiaBalance: number };
  estimated: true;
}
export const useScenario = () =>
  useMutation({ mutationFn: (changes: { nodeId: string; newValue: number }[]) => api<ScenarioResult>('/api/what-ifs/scenario', { method: 'POST', body: { changes } }) });
