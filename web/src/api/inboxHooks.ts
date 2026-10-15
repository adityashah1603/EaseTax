// The per-person inbox (GET /api/inbox). Like every query, the SSE stream invalidates it on each
// committed event, so it stays live without polling. Read marks are server-side events
// (POST /api/inbox/read, D-59), so they follow the person across browsers and devices.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { InboxDto, InboxItemDto } from '@easetax/shared';
import { useCallback, useMemo } from 'react';
import { api } from './client';
import { useSession } from '../state/session';

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
  const qc = useQueryClient();
  const key = ['inbox', actorId];
  const q = useQuery({ queryKey: key, queryFn: () => api<InboxDto>('/api/inbox') });
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const mark = useCallback(
    (ids: string[], read: boolean) => {
      const todo = ids.filter((id) => items.find((i) => i.id === id)?.read !== read);
      if (!todo.length) return;
      // Optimistic: flip locally, then record it; the SSE refresh confirms.
      qc.setQueryData<InboxDto>(key, (d) => (d ? { ...d, items: d.items.map((i) => (todo.includes(i.id) ? { ...i, read } : i)) } : d));
      api('/api/inbox/read', { method: 'POST', body: { ids: todo, read } }).catch(() => qc.invalidateQueries({ queryKey: key }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, actorId, qc],
  );
  return {
    items,
    unread: items.filter((i) => !i.read).length,
    isLoading: q.isLoading,
    error: q.error,
    markRead: (ids: string[]) => mark(ids, true),
    markUnread: (id: string) => mark([id], false),
  };
}
