// The per-person inbox (GET /api/inbox). Like every query, the SSE stream invalidates it on each
// committed event, so it stays live without polling.
//
// Read marks: the server has no notification.read event yet (events.ts is owned by the core), so
// for now they live in this browser, per actor, in localStorage. Items the server already reports
// as read stay read. TODO(core): when `notification.read` lands, POST the ids instead and drop
// the local store.
import { useQuery } from '@tanstack/react-query';
import type { InboxDto, InboxItemDto } from '@easetax/shared';
import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { api } from './client';
import { useSession } from '../state/session';

const KEY = (actorId: string) => `easetax.inbox.read.${actorId}`;
const listeners = new Set<() => void>();
const cache = new Map<string, ReadonlySet<string>>();
/** Cap so the stored list can't grow without bound; the oldest marks fall off first. */
const MAX_MARKS = 2000;

function load(actorId: string): ReadonlySet<string> {
  const hit = cache.get(actorId);
  if (hit) return hit;
  let ids: string[] = [];
  try {
    const raw = localStorage.getItem(KEY(actorId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    /* storage unavailable or corrupt: start empty */
  }
  const set = new Set(ids);
  cache.set(actorId, set);
  return set;
}

function save(actorId: string, ids: Set<string>) {
  const list = [...ids].slice(-MAX_MARKS);
  cache.set(actorId, new Set(list));
  try {
    localStorage.setItem(KEY(actorId), JSON.stringify(list));
  } catch {
    /* storage unavailable: marks last for this page load only */
  }
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key?.startsWith('easetax.inbox.read.')) {
      cache.clear();
      l();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

export interface Inbox {
  items: InboxItemDto[];
  unread: number;
  isLoading: boolean;
  error: unknown;
  markRead: (ids: string[]) => void;
  markUnread: (id: string) => void;
}

export function useInbox(): Inbox {
  const { actorId } = useSession();
  const q = useQuery({ queryKey: ['inbox', actorId], queryFn: () => api<InboxDto>('/api/inbox') });
  const marks = useSyncExternalStore(subscribe, () => load(actorId));
  const items = useMemo(() => (q.data?.items ?? []).map((i) => (i.read || marks.has(i.id) ? { ...i, read: true } : i)), [q.data, marks]);
  const markRead = useCallback(
    (ids: string[]) => {
      const next = new Set(load(actorId));
      let changed = false;
      for (const id of ids) if (!next.has(id)) (next.add(id), (changed = true));
      if (changed) save(actorId, next);
    },
    [actorId],
  );
  const markUnread = useCallback(
    (id: string) => {
      const next = new Set(load(actorId));
      if (next.delete(id)) save(actorId, next);
    },
    [actorId],
  );
  return { items, unread: items.filter((i) => !i.read).length, isLoading: q.isLoading, error: q.error, markRead, markUnread };
}
