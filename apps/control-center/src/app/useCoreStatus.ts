import { useQuery } from '@tanstack/react-query';
import { useRef } from 'react';

export interface CoreStatus {
  /** False when the core could not be reached; null until the first answer. */
  readonly reachable: boolean | null;
  /** The core answers ready only while its database does. */
  readonly ready: boolean;
  /** A new epoch starts each time the core process starts. */
  readonly epoch: string | null;
  /** The epoch changed while this page was open: the core restarted and held unfinished work. */
  readonly restarted: boolean;
}

/** Polls the core's public readiness check; every response names the epoch of the process that sent it. */
export function useCoreStatus(enabled: boolean): CoreStatus {
  const first = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ['core-status'],
    queryFn: async () => {
      const response = await fetch('/api/ready', { cache: 'no-store' });
      return { ready: response.ok, epoch: response.headers.get('x-lattice-core-epoch') };
    },
    enabled,
    refetchInterval: 5_000,
    retry: 0,
  });
  const epoch = query.data?.epoch ?? null;
  if (epoch !== null && first.current === null) first.current = epoch;
  return {
    reachable: query.isError ? false : query.data ? epoch !== null : null,
    ready: query.data?.ready ?? false,
    epoch,
    restarted: epoch !== null && first.current !== null && epoch !== first.current,
  };
}
