import { useEffect, useState } from 'react';

/** The longest delay a browser timer accepts. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Whether the time `at` has passed. It re-renders once, at that moment, instead of ticking every
 * second, so a review that expires or a fence that ends updates on time without a running clock.
 */
export function useReached(at: string | undefined): boolean {
  const time = at === undefined ? Number.NaN : Date.parse(at);
  const [, setTick] = useState(0);
  useEffect(() => {
    const wait = time - Date.now();
    if (Number.isNaN(wait) || wait < 0) return;
    const timer = window.setTimeout(
      () => setTick((tick) => tick + 1),
      Math.min(wait + 20, MAX_TIMER_MS),
    );
    return () => window.clearTimeout(timer);
  }, [time]);
  return !Number.isNaN(time) && Date.now() >= time;
}
