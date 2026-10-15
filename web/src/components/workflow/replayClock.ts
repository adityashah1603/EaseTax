// Replay clock (FR-9, D-13): a view filter, never a write. The chosen moment lives in the
// browser (per tab) and only changes what read queries ask for (documents ?asOf=) and how
// screens label what they show. Work events always show in real time.
import { useSyncExternalStore } from 'react';

const KEY = 'easetax.replayAt';
let at: string | null = read();
const listeners = new Set<() => void>();

function read(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setReplayAt(next: string | null) {
  at = next;
  try {
    if (next) sessionStorage.setItem(KEY, next);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the clock still works for this page load */
  }
  listeners.forEach((l) => l());
}

export function getReplayAt() {
  return at;
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** The replay moment (ISO timestamp), or null when the app shows the live state. */
export function useReplayAt(): string | null {
  return useSyncExternalStore(subscribe, getReplayAt, getReplayAt);
}
