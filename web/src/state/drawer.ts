// The trace drawer is URL-addressable: ?node=line:v3:F1040.1a&src=ev:ev-0016&act=verify
// so any number (and the exact source field behind it) is a shareable link.
import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

export type DrawerAction = 'verify' | 'adjust' | 'note' | 'ask' | 'evidence';

export interface AdjustPrefill {
  value: string;
  reason: string;
}

// Suggestion prefill travels in memory (not the URL) so links stay short.
let prefill: AdjustPrefill | null = null;
export const takePrefill = () => {
  const p = prefill;
  prefill = null;
  return p;
};

export function useDrawer() {
  const [params, setParams] = useSearchParams();
  const nodeId = params.get('node');
  const src = params.get('src');
  const act = params.get('act') as DrawerAction | null;

  const update = useCallback(
    (patch: Record<string, string | null>, replace = false) => {
      setParams(
        (p) => {
          const n = new URLSearchParams(p);
          for (const [k, v] of Object.entries(patch)) {
            if (v === null) n.delete(k);
            else n.set(k, v);
          }
          return n;
        },
        { replace },
      );
    },
    [setParams],
  );

  const open = useCallback(
    (id: string, opts?: { act?: DrawerAction; src?: string; prefill?: AdjustPrefill }) => {
      if (opts?.prefill) prefill = opts.prefill;
      update({ node: id, src: opts?.src ?? null, act: opts?.act ?? null });
    },
    [update],
  );
  const close = useCallback(() => update({ node: null, src: null, act: null }), [update]);
  const setSrc = useCallback((id: string | null) => update({ src: id }, true), [update]);
  const setAct = useCallback((a: DrawerAction | null) => update({ act: a }, true), [update]);

  return { nodeId, src, act, open, close, setSrc, setAct };
}
