import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '../../core/api/apiClient';
import type { Body } from '../../core/api/schemas';
import { observationTime } from '../memory/observation';
import {
  type ReportRouteCondition,
  type RouteCondition,
  type RouteConditions,
  routeConditionSchema,
} from './conditions';
import type { SemanticMap } from './navigation';

export function RouteConditionsPanel({
  map,
  snapshot,
  bodies,
  canOperate,
  unavailable,
}: {
  readonly map: SemanticMap;
  readonly snapshot: RouteConditions | undefined;
  readonly bodies: readonly Body[];
  readonly canOperate: boolean;
  readonly unavailable: string | undefined;
}) {
  const client = useQueryClient();
  const [segmentId, setSegmentId] = useState('');
  const [status, setStatus] = useState<'blocked' | 'clear'>('blocked');
  const [reason, setReason] = useState('');
  const [saved, setSaved] = useState<RouteCondition | null>(null);
  const [clearBinding, setClearBinding] = useState<{ revision: number; map_digest: string } | null>(
    null,
  );
  const report = useMutation({
    mutationFn: async (request: ReportRouteCondition) =>
      routeConditionSchema.parse(
        await apiClient.request('/navigation/conditions', {
          method: 'POST',
          body: JSON.stringify(request),
        }),
      ),
    onSuccess: async (condition) => {
      setSaved(condition);
      setReason('');
      setSegmentId('');
      setStatus('blocked');
      setClearBinding(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['route-conditions'] }),
        client.invalidateQueries({ queryKey: ['route-plans'] }),
        client.invalidateQueries({ queryKey: ['route-replans'] }),
        client.invalidateQueries({ queryKey: ['route-transfer-options'] }),
        client.invalidateQueries({ queryKey: ['rounds'] }),
        client.invalidateQueries({ queryKey: ['missions'] }),
        client.invalidateQueries({ queryKey: ['handoffs'] }),
        client.invalidateQueries({ queryKey: ['audit'] }),
      ]);
    },
    onError: async () => {
      await client.invalidateQueries({ queryKey: ['route-conditions'] });
    },
  });
  const bodyName = (id: string) => bodies.find((body) => body.id === id)?.display_name ?? id;
  const placeName = (id: string) =>
    map.places.find((place) => place.id === id)?.label ?? id.replaceAll('_', ' ');
  const segmentName = (id: string) => {
    const segment = map.segments.find((entry) => entry.id === id);
    return segment
      ? `${placeName(segment.from)} → ${placeName(segment.to)}`
      : id.replaceAll('_', ' ');
  };
  const unavailableMap = snapshot !== undefined && snapshot.map_id !== map.id;
  const clearChanged =
    status === 'clear' &&
    (!clearBinding ||
      clearBinding.revision !== snapshot?.revision ||
      clearBinding.map_digest !== snapshot?.map_digest);
  function edit() {
    setSaved(null);
    report.reset();
  }
  return (
    <section className="route-conditions" aria-labelledby="route-conditions-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Current knowledge about the route</p>
          <h3 id="route-conditions-heading">Route conditions</h3>
        </div>
        {snapshot && <span className="status-pill">Condition revision {snapshot.revision}</span>}
      </div>
      <p className="route-note">
        Condition reports supplement the configured map. A blocked segment stays blocked until an
        explicit clear report is accepted; elapsed time alone never clears it.
      </p>
      {unavailable && (
        <p className="notice error" role="status">
          Live route conditions are unavailable: {unavailable}
        </p>
      )}
      {unavailableMap && (
        <p className="notice error" role="status">
          The condition snapshot belongs to a different map. Refresh the configured map before
          reporting.
        </p>
      )}
      {snapshot && (
        <>
          {snapshot.blocked_segment_ids.length === 0 ? (
            <p className="empty-state">
              No segments are currently reported blocked. This describes recorded conditions, not a
              guarantee that the route is clear.
            </p>
          ) : (
            <div className="route-condition-cards">
              {snapshot.blocked_segment_ids.map((id) => {
                const latest = snapshot.conditions.find(
                  (condition) => condition.segment_id === id && condition.status === 'blocked',
                );
                return (
                  <article key={id}>
                    <div className="card-title-row">
                      <strong>{segmentName(id)}</strong>
                      <span className="status-pill blocked">Blocked</span>
                    </div>
                    {latest ? (
                      <ConditionDetails condition={latest} bodyName={bodyName} />
                    ) : (
                      <p className="route-note">
                        The current snapshot blocks this segment; report details are unavailable.
                      </p>
                    )}
                    {canOperate && (
                      <button
                        type="button"
                        className="secondary"
                        disabled={report.isPending || Boolean(unavailable) || unavailableMap}
                        onClick={() => {
                          setSegmentId(id);
                          setStatus('clear');
                          setClearBinding({
                            revision: snapshot.revision,
                            map_digest: snapshot.map_digest,
                          });
                          setReason('');
                          edit();
                        }}
                      >
                        Review clear report
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          )}
          {canOperate ? (
            <form
              className="route-condition-form"
              onSubmit={(event) => {
                event.preventDefault();
                setSaved(null);
                report.mutate({
                  event_id: `operator-${crypto.randomUUID()}`,
                  map_digest:
                    status === 'clear' && clearBinding
                      ? clearBinding.map_digest
                      : snapshot.map_digest,
                  segment_id: segmentId,
                  status,
                  reason: reason.trim(),
                  observed_at: new Date().toISOString(),
                  ...(status === 'clear' && clearBinding
                    ? { expected_revision: clearBinding.revision }
                    : {}),
                });
              }}
            >
              <h4>
                {status === 'clear'
                  ? 'Review an explicit clear report'
                  : 'Report a route condition'}
              </h4>
              <label>
                Route segment
                <select
                  value={segmentId}
                  disabled={report.isPending}
                  onChange={(event) => {
                    setSegmentId(event.target.value);
                    if (status === 'clear')
                      setClearBinding({
                        revision: snapshot.revision,
                        map_digest: snapshot.map_digest,
                      });
                    edit();
                  }}
                >
                  <option value="">Choose the affected segment</option>
                  {map.segments.map((segment) => (
                    <option key={segment.id} value={segment.id}>
                      {segmentName(segment.id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Reported condition
                <select
                  value={status}
                  disabled={report.isPending}
                  onChange={(event) => {
                    setStatus(event.target.value === 'clear' ? 'clear' : 'blocked');
                    setClearBinding(
                      event.target.value === 'clear'
                        ? { revision: snapshot.revision, map_digest: snapshot.map_digest }
                        : null,
                    );
                    edit();
                  }}
                >
                  <option value="blocked">Blocked — do not traverse</option>
                  <option value="clear">Clear — available to plan</option>
                </select>
              </label>
              <label>
                Reason for this report
                <textarea
                  rows={3}
                  minLength={5}
                  maxLength={240}
                  value={reason}
                  disabled={report.isPending}
                  onChange={(event) => {
                    setReason(event.target.value);
                    edit();
                  }}
                  placeholder={
                    status === 'clear'
                      ? 'Explain what was checked before reporting clear.'
                      : 'Describe the condition that prevents traversal.'
                  }
                />
              </label>
              <p className="route-note">
                This records an operator report at submission time.{' '}
                {status === 'clear'
                  ? 'Clearing a segment preserves its history and does not resume a held round, approve a replacement route, or authorize a body transfer.'
                  : 'A blocked report may hold affected execution. It does not move a body or authorize an alternative route.'}
              </p>
              <button
                type="submit"
                disabled={
                  report.isPending ||
                  !segmentId ||
                  reason.trim().length < 5 ||
                  clearChanged ||
                  Boolean(unavailable) ||
                  unavailableMap
                }
              >
                {report.isPending
                  ? 'Recording condition…'
                  : status === 'clear'
                    ? 'Confirm clear report'
                    : 'Record blocked condition'}
              </button>
              {clearChanged && (
                <div className="notice error" role="status">
                  <p>
                    The condition snapshot changed after this clear review. Inspect the latest
                    report before starting a new clear review.
                  </p>
                  <button
                    type="button"
                    className="secondary"
                    disabled={report.isPending || Boolean(unavailable) || unavailableMap}
                    onClick={() => {
                      setClearBinding({
                        revision: snapshot.revision,
                        map_digest: snapshot.map_digest,
                      });
                      setReason('');
                      edit();
                    }}
                  >
                    Review current condition before clearing
                  </button>
                </div>
              )}
            </form>
          ) : (
            <p className="route-note">
              Viewer access: inspect condition reports and sensor provenance. An operator records or
              clears a condition.
            </p>
          )}
          {saved && (
            <p className="notice" role="status">
              {saved.status === 'clear'
                ? 'Clear report recorded. Held execution still needs its own review.'
                : 'Blocked condition recorded. Review any affected held round before continuing.'}
            </p>
          )}
          {report.error && (
            <p className="notice error" role="alert">
              {report.error.message}
            </p>
          )}
          {snapshot.conditions.length > 0 && (
            <details className="route-condition-history">
              <summary>
                Recent condition reports ({Math.min(8, snapshot.conditions.length)})
              </summary>
              {snapshot.conditions.slice(0, 8).map((condition) => (
                <article key={condition.id}>
                  <div className="card-title-row">
                    <strong>{segmentName(condition.segment_id)}</strong>
                    <span className="status-pill">
                      {condition.status} · revision {condition.revision}
                    </span>
                  </div>
                  <ConditionDetails condition={condition} bodyName={bodyName} />
                </article>
              ))}
            </details>
          )}
        </>
      )}
    </section>
  );
}

function ConditionDetails({
  condition,
  bodyName,
}: {
  readonly condition: RouteCondition;
  readonly bodyName: (id: string) => string;
}) {
  const actor =
    'operator' in condition.actor
      ? `Operator: ${condition.actor.operator}`
      : 'body' in condition.actor
        ? `Body: ${condition.actor.body}`
        : `Service: ${condition.actor.service}`;
  return (
    <>
      <p>{condition.reason}</p>
      <p className="route-note">
        {condition.body_id ? `Reported by ${bodyName(condition.body_id)}` : actor}
        <br />
        Observed{' '}
        <time dateTime={condition.observed_at}>{observationTime(condition.observed_at)}</time>
        <br />
        Received{' '}
        <time dateTime={condition.received_at}>{observationTime(condition.received_at)}</time>
      </p>
      {condition.evidence && (
        <p className="route-note">
          Laser scan · nearest reported obstacle {condition.evidence.distance_m.toFixed(2)} m ·{' '}
          {condition.evidence.blocked_samples} blocked samples. This is sensor evidence of a blocked
          path; it does not identify the object.
        </p>
      )}
      <details className="route-binding">
        <summary>Condition provenance</summary>
        <dl className="handoff-facts">
          <div>
            <dt>Reporter</dt>
            <dd>{actor}</dd>
          </div>
          <div>
            <dt>Report identity</dt>
            <dd>
              <code>{condition.id}</code>
            </dd>
          </div>
          <div className="full-width">
            <dt>Map SHA-256</dt>
            <dd>
              <code>{condition.map_digest}</code>
            </dd>
          </div>
          {condition.expected_revision != null && (
            <div>
              <dt>Reviewed condition revision</dt>
              <dd>{condition.expected_revision}</dd>
            </div>
          )}
          {condition.command_id && (
            <div className="full-width">
              <dt>Bound command</dt>
              <dd>
                <code>{condition.command_id}</code>
              </dd>
            </div>
          )}
          {condition.evidence && (
            <>
              <div>
                <dt>Sensor frame</dt>
                <dd>{condition.evidence.frame_id}</dd>
              </div>
              <div>
                <dt>Observer pose</dt>
                <dd>
                  x {condition.evidence.observer_pose.x.toFixed(2)}, y{' '}
                  {condition.evidence.observer_pose.y.toFixed(2)}
                  {condition.evidence.observer_pose.z != null
                    ? `, z ${condition.evidence.observer_pose.z.toFixed(2)}`
                    : '; elevation not reported'}{' '}
                  m
                </dd>
              </div>
              <div className="full-width">
                <dt>Scan SHA-256</dt>
                <dd>
                  <code>{condition.evidence.scan_sha256}</code>
                </dd>
              </div>
            </>
          )}
        </dl>
      </details>
    </>
  );
}
