import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { apiClient } from '../../core/api/apiClient';
import type { Body } from '../../core/api/schemas';
import { useSectionActive } from '../../core/sectionActivity';
import { ObservationCard } from './ObservationCard';
import { lastSeenSchema, observationSchema } from './observation';

export function ObservationMemory({ bodies }: { readonly bodies: readonly Body[] }) {
  const active = useSectionActive();
  const [station, setStation] = useState('inspection_bay');
  const subject = `safety-marker:${station}`;
  const query = `subject=${encodeURIComponent(subject)}`;
  const lastSeen = useQuery({
    queryKey: ['last-seen', subject],
    queryFn: async () =>
      lastSeenSchema.parse(await apiClient.request(`/observations/last-seen?${query}`)),
    enabled: active,
    refetchInterval: 5000,
  });
  const observations = useQuery({
    queryKey: ['observations', subject],
    queryFn: async () =>
      z.array(observationSchema).parse(await apiClient.request(`/observations?limit=20&${query}`)),
    enabled: active,
    refetchInterval: 5000,
  });
  const bodyNames = new Map(bodies.map((body) => [body.id, body.display_name]));
  const sighting = lastSeen.data?.last_seen;
  const negative =
    lastSeen.data?.later_negative ??
    (!sighting
      ? observations.data?.find((observation) => observation.outcome === 'not_detected')
      : null);
  const history =
    observations.data?.filter((o) => o.id !== sighting?.id && o.id !== negative?.id) ?? [];
  const error = lastSeen.error ?? observations.error;
  return (
    <section className="plate memory-panel" aria-labelledby="memory-heading">
      <header className="plate-head">
        <div>
          <h2 id="memory-heading">Observation memory</h2>
          <p className="note">Recorded camera evidence, shared across bodies</p>
        </div>
      </header>
      <div className="plate-body">
        <p className="memory-note">
          Where was a safety marker last seen? Query retained inspections from every body. A later
          image with no detection stays visible alongside the last positive sighting.
        </p>
        <div className="memory-search">
          <label>
            Safety marker station
            <select value={station} onChange={(event) => setStation(event.target.value)}>
              <option value="inspection_bay">Inspection bay</option>
              <option value="loading_dock">Loading dock</option>
              <option value="charging_station">Charging station</option>
            </select>
          </label>
        </div>
        <p className="memory-note">
          Subjects are scoped to a station. The recorded position belongs to the observing rover;
          the camera does not establish an object’s exact map coordinates.
        </p>
        {lastSeen.isPending && <p role="status">Querying shared memory…</p>}
        {error && (
          <p className="notice error" role="alert">
            {error.message}
          </p>
        )}
        {lastSeen.data && (
          <div className="memory-results">
            <div>
              <h3>Last positive sighting</h3>
              {sighting ? (
                <ObservationCard
                  observation={sighting}
                  bodyName={bodyNames.get(sighting.body_id) ?? sighting.body_id}
                />
              ) : (
                <p className="empty-state">
                  No positive sighting has been recorded for this station.
                </p>
              )}
            </div>
            {negative && (
              <div>
                <h3>
                  {sighting
                    ? 'Later observation with no detection'
                    : 'Latest observation with no detection'}
                </h3>
                <ObservationCard
                  observation={negative}
                  bodyName={bodyNames.get(negative.body_id) ?? negative.body_id}
                />
              </div>
            )}
            <p className="memory-note">{lastSeen.data.explanation}</p>
          </div>
        )}
        {history.length > 0 && (
          <details>
            <summary>More recorded observations ({history.length})</summary>
            <div className="memory-results">
              {history.map((observation) => (
                <ObservationCard
                  key={observation.id}
                  observation={observation}
                  bodyName={bodyNames.get(observation.body_id) ?? observation.body_id}
                />
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  );
}
