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

async function parse<T>(res: Response): Promise<T> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = { ok: false, error: `${res.status} ${res.statusText}`, code: 'invalid' };
  }
  if (!res.ok) throw new ApiFailure(json as ApiError, res.status);
  return json as T;
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(path, {
    method: init?.method ?? 'GET',
    headers: { 'x-actor': actorId, ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  return parse<T>(res);
}

/** Multipart upload (attachments). */
export async function upload<T>(path: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(path, { method: 'POST', headers: { 'x-actor': actorId }, body: fd });
  return parse<T>(res);
}

export const enc = (nodeId: string) => encodeURIComponent(nodeId);

/** Human text for any thrown error; policy errors are shown verbatim with the firm rule they quote. */
export function errorText(e: unknown): { message: string; rule?: string } {
  if (e instanceof ApiFailure) return { message: e.body.error, rule: e.body.rule };
  return { message: e instanceof Error ? e.message : String(e) };
}
