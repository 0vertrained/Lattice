import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { apiClient } from '../../core/api/apiClient';
import type { Body } from '../../core/api/schemas';
import { observationTime } from '../memory/observation';
import { routeConditionsSchema } from './conditions';
import {
  type RouteObjective,
  type RouteProposal,
  routeProposalSchema,
  type SemanticMap,
  semanticMapSchema,
} from './navigation';
import { ReplanPanel } from './ReplanPanel';
import { CandidateAssessments } from './RouteAssessments';
import { RouteConditionsPanel } from './RouteConditions';
import { RouteGraph } from './RouteGraph';
import './navigation.css';

export function RoutePlanner({
  bodies,
  canOperate,
}: {
  readonly bodies: readonly Body[];
  readonly canOperate: boolean;
}) {
  const client = useQueryClient();
  const [sourceId, setSourceId] = useState('');
  const [sourcePlace, setSourcePlace] = useState('');
  const [destination, setDestination] = useState('');
  const [inspectSource, setInspectSource] = useState(true);
  const [inspectDestination, setInspectDestination] = useState(true);
  const [review, setReview] = useState<RouteProposal | null>(null);
  const [approvedRound, setApprovedRound] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const map = useQuery({
    queryKey: ['navigation-map'],
    queryFn: async () => semanticMapSchema.parse(await apiClient.request('/navigation/map')),
    refetchInterval: 10_000,
    retry: false,
  });
  const history = useQuery({
    queryKey: ['route-plans'],
    queryFn: async () =>
      z.array(routeProposalSchema).parse(await apiClient.request('/navigation/plans')),
    enabled: Boolean(map.data),
    refetchInterval: 2000,
  });
  const conditions = useQuery({
    queryKey: ['route-conditions'],
    queryFn: async () =>
      routeConditionsSchema.parse(await apiClient.request('/navigation/conditions')),
    enabled: Boolean(map.data),
    refetchInterval: 2000,
    retry: false,
  });
  const refresh = async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: ['route-plans'] }),
      client.invalidateQueries({ queryKey: ['rounds'] }),
      client.invalidateQueries({ queryKey: ['missions'] }),
      client.invalidateQueries({ queryKey: ['audit'] }),
      client.invalidateQueries({ queryKey: ['bodies'] }),
      client.invalidateQueries({ queryKey: ['route-transfer-options'] }),
      client.invalidateQueries({ queryKey: ['route-conditions'] }),
      client.invalidateQueries({ queryKey: ['route-replans'] }),
    ]);
  };
  const prepare = useMutation({
    mutationFn: async (request: RouteObjective) =>
      routeProposalSchema.parse(
        await apiClient.request('/navigation/plans', {
          method: 'POST',
          body: JSON.stringify(request),
        }),
      ),
    onSuccess: async (proposal) => {
      setReview(proposal);
      setApprovedRound('');
      await refresh();
    },
  });
  const approve = useMutation({
    mutationFn: async (proposal: RouteProposal) =>
      z.object({ id: z.string() }).parse(
        await apiClient.request(`/navigation/plans/${encodeURIComponent(proposal.id)}/approve`, {
          method: 'POST',
          body: JSON.stringify({ digest: proposal.digest }),
        }),
      ),
    onSuccess: async (round) => {
      setApprovedRound(round.id);
      setReview(null);
      await refresh();
    },
    onError: async () => {
      await refresh();
      await client.invalidateQueries({ queryKey: ['navigation-map'] });
    },
  });
  const source = bodies.find((body) => body.id === sourceId);
  const places = map.data?.places ?? [];
  const bodyName = (id: string) => bodies.find((body) => body.id === id)?.display_name ?? id;
  const placeName = (id: string) =>
    places.find((place) => place.id === id)?.label ?? id.replaceAll('_', ' ');
  const current = history.data?.find((proposal) => proposal.id === review?.id);
  const reviewStatus = current?.status ?? review?.status;
  const expired = review !== null && now >= Date.parse(review.expires_at);
  const mapChanged =
    review?.plan &&
    map.data &&
    (review.plan.map_id !== map.data.id || review.plan.map_revision !== map.data.revision);
  const conditionsChanged = Boolean(
    review?.adaptive &&
      (conditions.error ||
        !conditions.data ||
        review.adaptive.conditions_revision !== conditions.data.revision ||
        (review.plan && review.plan.map_digest !== conditions.data.map_digest)),
  );
  const error = prepare.error ?? approve.error ?? history.error;
  function editRequest() {
    setReview(null);
    setApprovedRound('');
    prepare.reset();
    approve.reset();
  }
  return (
    <section className="panel route-planner" aria-labelledby="route-planner-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Match the route to each body’s capabilities</p>
          <h2 id="route-planner-heading">Capability route planner</h2>
        </div>
        <span className="status-pill">Reviewed execution</span>
      </div>
      <p className="route-note">
        Plan a route through named places, explain where a different body is needed, and review
        every assignment before execution. A planned transfer still requires its own approval when
        the round reaches that point.
      </p>
      {map.isPending && <p className="empty-state">Loading the configured route map…</p>}
      {map.error && (
        <p className="empty-state">Route planning is unavailable: {map.error.message}</p>
      )}
      {map.data && (
        <>
          <div className="route-layout">
            <div className="route-map-pane">
              <div className="route-map-heading">
                <strong>{map.data.id.replaceAll('_', ' ')}</strong>
                <span>
                  Revision {map.data.revision} · {map.data.frame_id} frame
                </span>
              </div>
              <RouteGraph
                map={map.data}
                plan={review?.plan ?? null}
                blockedSegmentIds={conditions.data?.blocked_segment_ids ?? []}
              />
              <div className="route-map-legend">
                <span>━ Permitted route</span>
                <span className="stairs">━ Stairs capability</span>
                <span>┄ Closed or reported blocked</span>
                <span className="selected">━ Reviewed path</span>
              </div>
            </div>
            <div className="route-form-pane">
              {canOperate ? (
                <form
                  className="route-controls"
                  onSubmit={(event) => {
                    event.preventDefault();
                    approve.reset();
                    prepare.mutate({
                      route: {
                        source_body_id: sourceId,
                        source_place_id: sourcePlace,
                        destination_place_id: destination,
                        destination_capability: inspectDestination ? 'inspect' : null,
                      },
                      inspect_source: inspectSource,
                      inspect_destination: inspectDestination,
                    });
                  }}
                >
                  <label>
                    Starting body
                    <select
                      value={sourceId}
                      disabled={prepare.isPending || approve.isPending}
                      onChange={(event) => {
                        setSourceId(event.target.value);
                        setSourcePlace('');
                        editRequest();
                      }}
                    >
                      <option value="">Choose the body that begins the objective</option>
                      {bodies.map((body) => (
                        <option key={body.id} value={body.id}>
                          {body.display_name} · {body.kind} · {body.status.replaceAll('_', ' ')}
                        </option>
                      ))}
                    </select>
                  </label>
                  {source && (
                    <p className="route-note">
                      Capabilities: {source.capabilities.join(', ')}.{' '}
                      {source.pose
                        ? `Reported position: x ${source.pose.x.toFixed(2)}, y ${source.pose.y.toFixed(2)}${source.pose.z != null ? `, z ${source.pose.z.toFixed(2)}` : '; elevation not reported'} m.`
                        : 'No localization is reported.'}
                    </p>
                  )}
                  <label>
                    Starting place
                    <select
                      value={sourcePlace}
                      disabled={prepare.isPending || approve.isPending}
                      onChange={(event) => {
                        setSourcePlace(event.target.value);
                        editRequest();
                      }}
                    >
                      <option value="">Choose the body’s current place</option>
                      {places.map((place) => (
                        <option key={place.id} value={place.id}>
                          {place.label} · z {place.pose.z.toFixed(2)} m
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Destination
                    <select
                      value={destination}
                      disabled={prepare.isPending || approve.isPending}
                      onChange={(event) => {
                        setDestination(event.target.value);
                        editRequest();
                      }}
                    >
                      <option value="">Choose a destination</option>
                      {places.map((place) => (
                        <option key={place.id} value={place.id}>
                          {place.label} · z {place.pose.z.toFixed(2)} m
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="route-checkbox">
                    <input
                      type="checkbox"
                      checked={inspectSource}
                      disabled={prepare.isPending || approve.isPending}
                      onChange={(event) => {
                        setInspectSource(event.target.checked);
                        editRequest();
                      }}
                    />
                    Inspect before departure
                  </label>
                  <label className="route-checkbox">
                    <input
                      type="checkbox"
                      checked={inspectDestination}
                      disabled={prepare.isPending || approve.isPending}
                      onChange={(event) => {
                        setInspectDestination(event.target.checked);
                        editRequest();
                      }}
                    />
                    Inspect on arrival
                  </label>
                  <p className="route-note">
                    The source must be localized at its starting place. Any replacement body must
                    already be ready at a permitted transfer point. Planning does not move a body.
                  </p>
                  <button
                    type="submit"
                    disabled={
                      prepare.isPending ||
                      approve.isPending ||
                      !sourceId ||
                      !sourcePlace ||
                      !destination
                    }
                  >
                    {prepare.isPending ? 'Planning route…' : 'Prepare route review'}
                  </button>
                </form>
              ) : (
                <p className="route-note">
                  Viewer access: inspect the configured map and saved route plans. An operator
                  prepares and approves execution.
                </p>
              )}
            </div>
          </div>
          {review && (
            <div className="route-review">
              <div className="card-title-row">
                <h3>{review.plan ? 'Review the proposed route' : 'Route cannot be approved'}</h3>
                <span className={`status-pill ${reviewStatus}`}>{reviewStatus}</span>
              </div>
              <RouteDetails
                proposal={review}
                bodyName={bodyName}
                placeName={placeName}
                map={map.data}
              />
              {expired && review.status === 'pending' && (
                <p className="notice error" role="status">
                  This route review expired. Prepare a fresh plan before approval.
                </p>
              )}
              {mapChanged && (
                <p className="notice error" role="status">
                  The configured map revision changed. Prepare a fresh plan against the current map.
                </p>
              )}
              {conditionsChanged && (
                <p className="notice error" role="status">
                  Route conditions changed or their current snapshot is unavailable. Prepare a fresh
                  review against the current conditions before approval.
                </p>
              )}
              {reviewStatus !== 'pending' && reviewStatus !== 'blocked' && (
                <p className="route-note">
                  This review is now {reviewStatus}. Its original plan remains available for
                  inspection.
                </p>
              )}
              <div className="actions">
                <button
                  type="button"
                  className="secondary"
                  disabled={approve.isPending}
                  onClick={() => {
                    setReview(null);
                    prepare.reset();
                    approve.reset();
                  }}
                >
                  Close route review
                </button>
                {canOperate && review.plan && (
                  <button
                    type="button"
                    disabled={
                      approve.isPending ||
                      expired ||
                      Boolean(mapChanged) ||
                      conditionsChanged ||
                      reviewStatus !== 'pending'
                    }
                    onClick={() => approve.mutate(review)}
                  >
                    {approve.isPending ? 'Approving route…' : 'Approve reviewed route'}
                  </button>
                )}
              </div>
            </div>
          )}
          {approvedRound && (
            <p className="notice" role="status">
              Route approved as round {approvedRound.slice(-8)}. The source can execute its reviewed
              steps; ownership changes remain held for a separate handoff review.
            </p>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error.message}
            </p>
          )}
          <div className="route-plan-history">
            <h3>Route planning history</h3>
            {history.data?.length === 0 && (
              <p className="empty-state">No route objectives have been reviewed yet.</p>
            )}
            {history.data?.slice(0, 6).map((proposal) => (
              <article key={proposal.id}>
                <div>
                  <strong>
                    {placeName(proposal.request.route.source_place_id)} →{' '}
                    {placeName(proposal.request.route.destination_place_id)}
                  </strong>
                  <small>
                    {bodyName(proposal.request.route.source_body_id)} · {proposal.status} ·{' '}
                    {observationTime(proposal.created_at)}
                  </small>
                </div>
                <button
                  type="button"
                  className="secondary"
                  disabled={prepare.isPending || approve.isPending}
                  onClick={() => {
                    setReview(proposal);
                    setSourceId(proposal.request.route.source_body_id);
                    setSourcePlace(proposal.request.route.source_place_id);
                    setDestination(proposal.request.route.destination_place_id);
                    setInspectSource(proposal.request.inspect_source);
                    setInspectDestination(proposal.request.inspect_destination);
                    prepare.reset();
                    approve.reset();
                    setApprovedRound('');
                  }}
                >
                  View route plan
                </button>
              </article>
            ))}
          </div>
          <RouteConditionsPanel
            map={map.data}
            snapshot={conditions.data}
            bodies={bodies}
            canOperate={canOperate}
            unavailable={conditions.error?.message}
          />
          <ReplanPanel
            map={map.data}
            conditions={conditions.data}
            bodies={bodies}
            canOperate={canOperate}
            conditionsUnavailable={Boolean(conditions.error)}
          />
        </>
      )}
    </section>
  );
}

function RouteDetails({
  proposal,
  bodyName,
  placeName,
  map,
}: {
  readonly proposal: RouteProposal;
  readonly bodyName: (id: string) => string;
  readonly placeName: (id: string) => string;
  readonly map: SemanticMap;
}) {
  const plan = proposal.plan;
  return (
    <>
      <p>
        <strong>
          {placeName(proposal.request.route.source_place_id)} →{' '}
          {placeName(proposal.request.route.destination_place_id)}
        </strong>{' '}
        · starting with {bodyName(proposal.request.route.source_body_id)}
        {plan && <> · finishing with {bodyName(plan.destination_body_id)}</>}.
      </p>
      {proposal.failure && <p className="notice error">{proposal.failure.message}</p>}
      {plan && (
        <>
          <p className="route-note">
            {plan.distance_m.toFixed(2)} m of semantic graph edges · {plan.legs.length} route
            segments · {plan.transfers.length} reviewed{' '}
            {plan.transfers.length === 1 ? 'transfer' : 'transfers'}. This distance is a planning
            cost, not measured travel.
          </p>
          <ul className="route-explanation">
            {plan.explanation.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <h4>Body assignments</h4>
          <ol className="route-assignments">
            {proposal.steps.map((step, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: The signed proposal freezes step order, including repeated commands.
              <li key={`${index}-${step.title}`}>
                <strong>{step.title}</strong>
                <span>{bodyName(proposal.step_body_ids[index] ?? '')}</span>
                {step.command.type === 'traverse_route' && (
                  <small>
                    {step.command.traversal.required_capabilities.join(', ')} required · maximum{' '}
                    {step.command.traversal.max_speed_mps} m/s
                  </small>
                )}
              </li>
            ))}
          </ol>
          {plan.transfers.length > 0 && (
            <>
              <h4>Why the body changes</h4>
              <div className="route-transfer-list">
                {plan.transfers.map((transfer) => (
                  <article key={`${transfer.before_leg_index}-${transfer.target_body_id}`}>
                    <strong>
                      {bodyName(transfer.source_body_id)} → {bodyName(transfer.target_body_id)}
                    </strong>
                    <p>
                      At {placeName(transfer.place_id)},{' '}
                      {transfer.before_leg_index < plan.legs.length
                        ? `before route segment ${transfer.before_leg_index + 1}`
                        : 'after the final route segment'}
                      .
                    </p>
                    <p>{transfer.reason}</p>
                    <small>
                      The source stops at this boundary. An operator reviews the current target
                      readiness and retained evidence before continuing.
                    </small>
                  </article>
                ))}
              </div>
            </>
          )}
        </>
      )}
      <CandidateAssessments
        assessments={plan?.assessments ?? proposal.failure?.assessments ?? []}
        bodyName={bodyName}
        placeName={placeName}
        map={map}
      />
      <details className="route-binding">
        <summary>Review binding and provenance</summary>
        <dl className="handoff-facts">
          <div>
            <dt>Review expires</dt>
            <dd>
              <time dateTime={proposal.expires_at}>{observationTime(proposal.expires_at)}</time>
            </dd>
          </div>
          <div>
            <dt>Plan identity</dt>
            <dd>
              <code>{proposal.id}</code>
            </dd>
          </div>
          {plan && (
            <>
              <div>
                <dt>Map revision</dt>
                <dd>
                  {plan.map_id} · {plan.map_revision}
                </dd>
              </div>
              <div>
                <dt>Planner</dt>
                <dd>{plan.planner_id}</dd>
              </div>
              <div className="full-width">
                <dt>Map SHA-256</dt>
                <dd>
                  <code>{plan.map_digest}</code>
                </dd>
              </div>
            </>
          )}
          <div className="full-width">
            <dt>Proposal SHA-256</dt>
            <dd>
              <code>{proposal.digest}</code>
            </dd>
          </div>
        </dl>
      </details>
    </>
  );
}
