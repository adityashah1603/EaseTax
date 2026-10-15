// Typed API client. The acting user (role switcher, D-09) is sent as X-Actor on every call.
import type { ApiError } from '@easetax/shared';

let actorId = localStorageGet('easetax.actor') ?? 'st-01';

export function getActor() {
  return actorId;
}
export function setActor(id: string) {
  actorId = id;
  try {
    localStorage.setItem('easetax.actor', id);
  } catch {
    /* storage unavailable */
  }
}

function localStorageGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}

export class ApiFailure extends Error {
  constructor(public body: ApiError, public status: number) {
    super(body.error);
  }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: { 'x-actor': actorId, ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new ApiFailure(json as ApiError, res.status);
  return json as T;
}

export const enc = (nodeId: string) => encodeURIComponent(nodeId);
