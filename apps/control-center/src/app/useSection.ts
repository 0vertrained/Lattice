import { useEffect, useState } from 'react';
import type { SectionId } from './sections';

const fromHash = (available: readonly SectionId[]): SectionId => {
  const id = window.location.hash.slice(1);
  return available.find((section) => section === id) ?? available[0] ?? 'fleet';
};

/**
 * The open section follows the address's hash, so links, reloads and the back button work.
 * `moved` counts the operator's own moves between sections: focus follows those, not the first load.
 */
export function useSection(available: readonly SectionId[]) {
  const key = available.join(' ');
  const [current, setCurrent] = useState<SectionId>(() => fromHash(available));
  const [moved, setMoved] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the list of sections.
  useEffect(() => {
    setCurrent(fromHash(available));
    const follow = () => {
      setCurrent(fromHash(available));
      setMoved((count) => count + 1);
    };
    window.addEventListener('hashchange', follow);
    return () => window.removeEventListener('hashchange', follow);
  }, [key]);
  return { current, moved } as const;
}
