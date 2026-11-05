import { createContext, useContext } from 'react';

/**
 * Whether the console section a component sits in is the one on screen. Opened sections stay
 * mounted while hidden, so their queries use this to stop polling until they are shown again;
 * React Query refetches stale data the moment a query is enabled.
 */
export const SectionActivity = createContext(true);

export function useSectionActive(): boolean {
  return useContext(SectionActivity);
}
