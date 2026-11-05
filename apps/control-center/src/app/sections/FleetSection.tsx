import { lazy, Suspense, useMemo, useRef } from 'react';
import { BodyPlate } from '../../features/fleet/BodyPlate';
import { recordBeat } from '../../features/fleet/heartbeats';
import { useNow } from '../../features/fleet/useNow';
import type { SectionProps } from '../Shell';

const DigitalTwin = lazy(() =>
  import('../../features/digital-twin/DigitalTwin').then((module) => ({
    default: module.DigitalTwin,
  })),
);

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function FleetSection({ bodies, bodiesLoading }: SectionProps) {
  const root = useRef<HTMLDivElement>(null);
  // Each poll's newest report is one beat on the trace. Traces scroll smoothly, or update once a
  // second when motion is reduced.
  const now = useNow(root, still() ? 1_000 : 250);
  const history = useRef(new Map<string, readonly number[]>());
  const beats = useMemo(() => {
    for (const body of bodies)
      history.current.set(
        body.id,
        recordBeat(history.current.get(body.id) ?? [], Date.parse(body.last_seen)),
      );
    return new Map(history.current);
  }, [bodies]);
  return (
    <div className="fleet" ref={root}>
      {bodiesLoading && (
        <p className="section-loading" role="status">
          Loading the fleet…
        </p>
      )}
      {!bodiesLoading && bodies.length === 0 && (
        <p className="empty-state">
          No body has registered yet. Start a simulator adapter or the mock body and it appears
          here.
        </p>
      )}
      <div className="fleet-plates">
        {bodies.map((body) => (
          <BodyPlate key={body.id} body={body} beats={beats.get(body.id) ?? []} now={now} />
        ))}
      </div>
      <Suspense fallback={<div className="plate twin-plate twin-loading" />}>
        <DigitalTwin bodies={bodies} />
      </Suspense>
    </div>
  );
}
