// Live collaboration over SSE (D-11): committed events invalidate the query cache and
// presence shows who else is looking at what.
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';

export interface Presence {
  actor: string;
  focus?: string;
}
export interface LiveEvent {
  seq: number;
  type: string;
  actor: string;
  at: string;
  payload: unknown;
}

interface StreamState {
  connected: boolean;
  presence: Presence[];
  recent: LiveEvent[];
}

const Ctx = createContext<StreamState>({ connected: false, presence: [], recent: [] });

export function StreamProvider({ actorId, children }: { actorId: string; children: ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<StreamState>({ connected: false, presence: [], recent: [] });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loc = useLocation();
  const [params] = useSearchParams();
  const focus = params.get('node') ?? loc.pathname;

  useEffect(() => {
    const connect = () => {
      const source = new EventSource(`/api/stream?actor=${encodeURIComponent(actorId)}&focus=${encodeURIComponent(focus)}`);
      source.addEventListener('hello', () => setState((s) => ({ ...s, connected: true })));
      source.addEventListener('events', (m) => {
        const evs = JSON.parse((m as MessageEvent).data) as LiveEvent[];
        setState((s) => ({ ...s, recent: [...evs.filter((e) => e.type !== 'seen.marked'), ...s.recent].slice(0, 30) }));
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(
          () => qc.invalidateQueries({ predicate: (q) => !['me', 'standards'].includes(q.queryKey[0] as string) }),
          120,
        );
      });
      source.addEventListener('presence', (m) => setState((s) => ({ ...s, presence: JSON.parse((m as MessageEvent).data) as Presence[] })));
      source.onerror = () => setState((s) => ({ ...s, connected: false }));
      source.onopen = () => setState((s) => ({ ...s, connected: true }));
      return source;
    };

    // W6 (D-63): a page the browser keeps for back/forward navigation keeps its EventSource
    // open. A few navigations later those idle streams fill the browser's 6-connections-per-host
    // limit (HTTP/1.1) and every request queues behind them. Close the stream on pagehide and
    // reconnect (and refresh, since events were missed) when the page is restored.
    let es: EventSource | null = connect();
    const close = () => {
      es?.close();
      es = null;
      setState((s) => ({ ...s, connected: false }));
    };
    const onShow = (e: PageTransitionEvent) => {
      if (es) return;
      es = connect();
      if (e.persisted) qc.invalidateQueries();
    };
    window.addEventListener('pagehide', close);
    window.addEventListener('pageshow', onShow);
    return () => {
      window.removeEventListener('pagehide', close);
      window.removeEventListener('pageshow', onShow);
      close();
    };
    // Reconnect only when the actor changes; focus is pushed separately below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, qc]);

  useEffect(() => {
    const t = setTimeout(() => {
      api('/api/presence', { method: 'POST', body: { actor: actorId, focus } }).catch(() => undefined);
    }, 400);
    return () => clearTimeout(t);
  }, [actorId, focus]);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

export const useStream = () => useContext(Ctx);
