// Minimal keyboard layer: single-key shortcuts that never fire while typing.
import { useEffect, useRef } from 'react';

export type KeyMap = Record<string, (e: KeyboardEvent) => void>;

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

/** Later-registered maps win, so an open drawer can take over j/k/v/a/n from the list behind it. */
const stack: { map: React.MutableRefObject<KeyMap>; enabled: React.MutableRefObject<boolean> }[] = [];
let installed = false;

function install() {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key !== 'Escape' && isTyping(e)) return;
    if (document.querySelector('[data-modal-open="true"]') && e.key !== 'Escape') return;
    for (let i = stack.length - 1; i >= 0; i--) {
      const entry = stack[i]!;
      if (!entry.enabled.current) continue;
      const fn = entry.map.current[e.key];
      if (fn) {
        e.preventDefault();
        fn(e);
        return;
      }
    }
  });
}

export function useHotkeys(map: KeyMap, enabled = true) {
  const mapRef = useRef(map);
  const enabledRef = useRef(enabled);
  mapRef.current = map;
  enabledRef.current = enabled;
  useEffect(() => {
    install();
    const entry = { map: mapRef, enabled: enabledRef };
    stack.push(entry);
    return () => {
      const i = stack.indexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, []);
}
