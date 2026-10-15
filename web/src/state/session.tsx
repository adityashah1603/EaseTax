// Who is acting (role switcher, D-09). The server enforces every rule; the UI only uses
// role to decide which buttons to offer, and still shows the server's error verbatim.
import type { Actor, Role } from '@easetax/shared';
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { getActor, setActor } from '../api/client';
import { useMe } from '../api/hooks';

type Action = 'verify' | 'adjust' | 'approve' | 'note' | 'resolve' | 'ask' | 'attach' | 'disposition' | 'signoff' | 'undo';

const STAFF_WORK: Role[] = ['preparer', 'reviewer', 'partner'];
const ALLOWED: Record<Action, Role[]> = {
  verify: STAFF_WORK,
  adjust: STAFF_WORK,
  approve: ['partner'],
  note: [...STAFF_WORK, 'quality_reviewer'],
  resolve: STAFF_WORK,
  ask: STAFF_WORK,
  attach: [...STAFF_WORK, 'client'],
  disposition: STAFF_WORK,
  signoff: STAFF_WORK,
  undo: STAFF_WORK,
};

interface Session {
  actorId: string;
  actor: Actor | undefined;
  actors: Actor[];
  switchTo: (id: string) => void;
  can: (a: Action) => boolean;
  nameOf: (id: string) => string;
  isClient: boolean;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [actorId, setActorId] = useState(getActor());
  const qc = useQueryClient();
  const me = useMe();
  const actors = me.data?.actors ?? [];
  const actor = actors.find((a) => a.id === actorId) ?? me.data?.actor;

  const switchTo = useCallback(
    (id: string) => {
      setActor(id);
      setActorId(id);
      // Masking and visibility depend on who asks, so drop every cached answer.
      qc.resetQueries();
    },
    [qc],
  );

  const value = useMemo<Session>(
    () => ({
      actorId,
      actor,
      actors,
      switchTo,
      can: (a) => !!actor && ALLOWED[a].includes(actor.role),
      nameOf: (id) => {
        if (id === 'client') return 'Client';
        if (id === 'system' || id === 'policy') return 'Firm policy';
        const a = actors.find((x) => x.id === id);
        return a ? a.name : id;
      },
      isClient: actor?.kind === 'client',
    }),
    [actorId, actor, actors, switchTo],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const s = useContext(Ctx);
  if (!s) throw new Error('SessionProvider missing');
  return s;
}

export const ROLE_LABEL: Record<Role, string> = {
  preparer: 'Preparer',
  reviewer: 'Reviewer',
  partner: 'Partner',
  firm_administrator: 'Firm administrator',
  quality_reviewer: 'Quality reviewer',
  client: 'Client',
};
