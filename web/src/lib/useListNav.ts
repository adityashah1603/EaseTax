// j/k selection over a list, with Enter/v/a/n/x handed to the page.
import { useEffect, useState } from 'react';
import { useDrawer } from '../state/drawer';
import { useHotkeys, type KeyMap } from './hotkeys';

export function useListNav(count: number, keys: KeyMap = {}, onMove?: (i: number) => void) {
  const [index, setIndex] = useState(0);
  const { nodeId } = useDrawer();
  useEffect(() => {
    if (index >= count && count > 0) setIndex(count - 1);
  }, [count, index]);
  useHotkeys(
    {
      j: () => {
        const i = Math.min(count - 1, index + 1);
        setIndex(i);
        onMove?.(i);
      },
      k: () => {
        const i = Math.max(0, index - 1);
        setIndex(i);
        onMove?.(i);
      },
      ...keys,
    },
    !nodeId && count > 0,
  );
  return [index, setIndex] as const;
}
