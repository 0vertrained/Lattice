import { type RefObject, useEffect, useState } from 'react';

/**
 * The current time, refreshed every `interval` while `ref`'s element is on screen and the tab is visible,
 * so a hidden section or a background tab costs nothing.
 */
export function useNow(ref: RefObject<Element | null>, interval: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const element = ref.current;
      if (document.hidden || !(element instanceof HTMLElement) || element.offsetParent === null)
        return;
      setNow(Date.now());
    }, interval);
    return () => window.clearInterval(timer);
  }, [ref, interval]);
  return now;
}
