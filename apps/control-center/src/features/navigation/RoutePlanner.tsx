import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { apiClient } from '../../core/api/apiClient';
import type { Body } from '../../core/api/schemas';
import { useSectionActive } from '../../core/sectionActivity';
import { GuardedAction } from '../guard/GuardedAction';
import { useReached } from '../guard/useReached';
import { observationTime } from '../memory/observation';
import { StatusChip } from '../status';
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
import { RouteMap, SearchSteps } from './RouteMap';
import { RouteRanking } from './RouteRanking';
import { type RouteNames, routeNames, sentence, speed } from './routeNames';
import './navigation.css';

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function RoutePlanner({
  bodies,
  canOperate,
}: {
  readonly bodies: readonly Body[];
  readonly canOperate: boolean;
}) {
  const client = useQueryClient();
  const active = useSectionActive();
  const [sourceId, setSourceId] = useState('');
  const [sourcePlace, setSourcePlace] = useState('');
  const [destination, setDestination] = useState('');
  const [inspectSource, setInspectSource] = useState(true);
  const [inspectDestination, setInspectDestination] = useState(true);
  const [review, setReview] = useState<RouteProposal | null>(null);
  const [approvedRound, setApprovedRound] = useState('');
  const map = useQuery({
    queryKey: ['navigation-map'],
    queryFn: async () => semanticMapSchema.parse(await apiClient.request('/navigation/map')),
    enabled: active,
    refetchInterval: 10_000,
    retry: false,
  });
  const history = useQuery({
    queryKey: ['route-plans'],
    queryFn: async () =>
      z.array(routeProposalSchema).parse(await apiClient.request('/navigation/plans')),
    enabled: active && Boolean(map.data),
    refetchInterval: 2000,
  });
  const conditions = useQuery({
    queryKey: ['route-conditions'],
    queryFn: async () =>
      routeConditionsSchema.parse(await apiClient.request('/navigation/conditions')),
    enabled: active && Boolean(map.data),
    refetchInterval: 2000,
    retry: false,
  });
  const refresh = async () => {
    await Promise.all(
      [
        'route-plans',
        'rounds',
        'missions',
        'audit',
        'bodies',
        'route-transfer-options',
        'route-conditions',
        'route-replans',
      ].map((key) => client.invalidateQueries({ queryKey: [key] })),
    );
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
  const expired = useReached(review?.expires_at);
  const source = bodies.find((body) => body.id === sourceId);
  const places = map.data?.places ?? [];
  const names = routeNames(map.data, bodies);
  const levels = new Set(places.map((place) => place.pose.z.toFixed(2))).size > 1;
  const placeOption = (place: SemanticMap['places'][number]) =>
    levels ? `${place.label}, z ${place.pose.z.toFixed(2)} m` : place.label;
  const busy = prepare.isPending || approve.isPending;
  const error = prepare.error ?? approve.error ?? history.error;
  function editRequest() {
    setReview(null);
    setApprovedRound('');
    prepare.reset();
    approve.reset();
  }
  return (
    <section className="route-planner" aria-labelledby="route-planner-heading">
      <div className="plate route-plate">
        <header className="plate-head">
          <div>
            <h2 id="route-planner-heading">Capability route planner</h2>
            {map.data && (
              <p className="note">
                {sentence(map.data.id)}, revision {map.data.revision}, {map.data.frame_id} frame
              </p>
            )}
          </div>
        </header>
        <p className="plate-intro">
          Plan a route through named places, see where a different body is needed, and review every
          assignment before execution. A planned transfer still needs its own approval when the
          round reaches it.
        </p>
        {map.isPending && (
          <p className="plate-intro empty-state">Loading the configured route map…</p>
        )}
        {map.error && (
          <p className="plate-intro empty-state">
            Route planning is unavailable: {map.error.message}
          </p>
        )}
        {map.data && (
          <div className="route-layout">
            <RouteMap
              map={map.data}
              plan={review?.plan ?? null}
              playKey={review?.id ?? null}
              blockedSegmentIds={conditions.data?.blocked_segment_ids ?? []}
              placeName={names.placeName}
              bodyName={names.bodyName}
            />
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
                  <h3>Plan a route</h3>
                  <label>
                    Starting body
                    <select
                      value={sourceId}
                      disabled={busy}
                      onChange={(event) => {
                        setSourceId(event.target.value);
                        setSourcePlace('');
                        editRequest();
                      }}
                    >
                      <option value="">Choose the body that begins the objective</option>
                      {bodies.map((body) => (
                        <option key={body.id} value={body.id}>
                          {body.display_name} ({body.kind}, {body.status.replaceAll('_', ' ')})
                        </option>
                      ))}
                    </select>
                  </label>
                  {source && (
                    <p className="route-note">
                      Can {source.capabilities.join(', ')}.{' '}
                      {source.pose
                        ? `Reported at x ${source.pose.x.toFixed(2)} m, y ${source.pose.y.toFixed(2)} m${source.pose.z != null ? `, z ${source.pose.z.toFixed(2)} m` : ', elevation not reported'}.`
                        : 'No localization is reported.'}
                    </p>
                  )}
                  <label>
                    Starting place
                    <select
                      value={sourcePlace}
                      disabled={busy}
                      onChange={(event) => {
                        setSourcePlace(event.target.value);
                        editRequest();
                      }}
                    >
                      <option value="">Choose the body’s current place</option>
                      {places.map((place) => (
                        <option key={place.id} value={place.id}>
                          {placeOption(place)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Destination
                    <select
                      value={destination}
                      disabled={busy}
                      onChange={(event) => {
                        setDestination(event.target.value);
                        editRequest();
                      }}
                    >
                      <option value="">Choose a destination</option>
                      {places.map((place) => (
                        <option key={place.id} value={place.id}>
                          {placeOption(place)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="route-checkbox">
                    <input
                      type="checkbox"
                      checked={inspectSource}
                      disabled={busy}
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
                      disabled={busy}
                      onChange={(event) => {
                        setInspectDestination(event.target.checked);
                        editRequest();
                      }}
                    />
                    Inspect on arrival
                  </label>
                  <p className="route-note">
                    The source must be localized at its starting place. A replacement body must
                    already wait at a permitted transfer point. Planning moves nothing.
                  </p>
                  <button
                    type="submit"
                    disabled={busy || !sourceId || !sourcePlace || !destination}
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
        )}
        {map.data && (
          <div className="route-plan-history">
            <h3>Recent route plans</h3>
            {history.data?.length === 0 && (
              <p className="empty-state">No route objectives have been reviewed yet.</p>
            )}
            <ul>
              {history.data?.slice(0, 6).map((proposal) => (
                <li key={proposal.id}>
                  <div>
                    <strong>
                      {names.placeName(proposal.request.route.source_place_id)} to{' '}
                      {names.placeName(proposal.request.route.destination_place_id)}
                    </strong>
                    <small>
                      Starting with {names.bodyName(proposal.request.route.source_body_id)},{' '}
                      <time dateTime={proposal.created_at}>
                        {observationTime(proposal.created_at)}
                      </time>
                    </small>
                  </div>
                  <StatusChip status={proposal.status} />
                  <button
                    type="button"
                    className="secondary"
                    disabled={busy}
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
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {review && map.data && (
        <RouteReview
          review={review}
          current={history.data?.find((proposal) => proposal.id === review.id)}
          map={map.data}
          conditions={conditions.data}
          conditionsUnavailable={Boolean(conditions.error)}
          expired={expired}
          names={names}
          canOperate={canOperate}
          approving={approve.isPending}
          onClose={() => {
            setReview(null);
            prepare.reset();
            approve.reset();
          }}
          onApprove={() => approve.mutate(review)}
        />
      )}
      {approvedRound && (
        <p className="notice" role="status">
          Route approved as round {approvedRound.slice(-8)}. The source can run its reviewed steps;
          each change of body waits for its own handoff review.
        </p>
      )}
      {error && (
        <p className="notice error" role="alert">
          {error.message}
        </p>
      )}
      {map.data && (
        <>
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

function RouteReview({
  review,
  current,
  map,
  conditions,
  conditionsUnavailable,
  expired,
  names,
  canOperate,
  approving,
  onClose,
  onApprove,
}: {
  readonly review: RouteProposal;
  readonly current: RouteProposal | undefined;
  readonly map: SemanticMap;
  readonly conditions: z.infer<typeof routeConditionsSchema> | undefined;
  readonly conditionsUnavailable: boolean;
  readonly expired: boolean;
  readonly names: RouteNames;
  readonly canOperate: boolean;
  readonly approving: boolean;
  readonly onClose: () => void;
  readonly onApprove: () => void;
}) {
  const plan = review.plan;
  const status = current?.status ?? review.status;
  const mapChanged =
    plan !== null && (plan.map_id !== map.id || plan.map_revision !== map.revision);
  const conditionsChanged = Boolean(
    review.adaptive &&
      (conditionsUnavailable ||
        !conditions ||
        review.adaptive.conditions_revision !== conditions.revision ||
        (plan && plan.map_digest !== conditions.map_digest)),
  );
  const { placeName, bodyName } = names;
  return (
    <section className="review-box route-review" aria-labelledby="route-review-heading">
      <div className="card-title-row">
        <h3 id="route-review-heading">
          {plan ? 'Review the proposed route' : 'Route cannot be approved'}
        </h3>
        <StatusChip status={status} />
      </div>
      <p>
        <strong>
          {placeName(review.request.route.source_place_id)} to{' '}
          {placeName(review.request.route.destination_place_id)}
        </strong>
        , starting with {bodyName(review.request.route.source_body_id)}
        {plan && <> and finishing with {bodyName(plan.destination_body_id)}</>}.
      </p>
      {review.failure && <p className="notice error">{review.failure.message}</p>}
      {plan && (
        <>
          <dl className="route-readouts">
            <div>
              <dt>Graph distance</dt>
              <dd className="figures">{plan.distance_m.toFixed(2)} m</dd>
            </div>
            <div>
              <dt>Segments</dt>
              <dd className="figures">{plan.legs.length}</dd>
            </div>
            <div>
              <dt>Body changes</dt>
              <dd className="figures">{plan.transfers.length}</dd>
            </div>
          </dl>
          <p className="route-note">
            The distance sums straight lines between places. It is the planner’s cost, not measured
            travel.
          </p>
          <RouteRanking plan={plan} map={map} placeName={placeName} bodyName={bodyName} />
          <SearchSteps
            plan={plan}
            placeName={placeName}
            bodyName={bodyName}
            segmentName={names.segmentName}
          />
          <h4>Why this plan</h4>
          <ul className="route-explanation">
            {plan.explanation.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
          <h4>Body assignments</h4>
          <ol className="route-assignments">
            {review.steps.map((step, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: The signed proposal freezes step order, including repeated commands.
              <li key={`${index}-${step.title}`}>
                <strong>{step.title}</strong>
                <span>{bodyName(review.step_body_ids[index] ?? '')}</span>
                {step.command.type === 'traverse_route' && (
                  <small>
                    Needs {step.command.traversal.required_capabilities.join(', ')}, at most{' '}
                    {speed(step.command.traversal.max_speed_mps)}
                  </small>
                )}
              </li>
            ))}
          </ol>
          {plan.transfers.length > 0 && (
            <>
              <h4>Why the body changes</h4>
              <ul className="route-transfer-list">
                {plan.transfers.map((transfer) => (
                  <li key={`${transfer.before_leg_index}-${transfer.target_body_id}`}>
                    <strong>
                      {bodyName(transfer.source_body_id)} hands over to{' '}
                      {bodyName(transfer.target_body_id)}
                    </strong>
                    <p>
                      At {placeName(transfer.place_id)},{' '}
                      {transfer.before_leg_index < plan.legs.length
                        ? `before route segment ${transfer.before_leg_index + 1}`
                        : 'after the final route segment'}
                      . {transfer.reason}
                    </p>
                    <small>
                      The source stops at this boundary. An operator reviews the target’s current
                      readiness and the retained evidence before continuing.
                    </small>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      <CandidateAssessments
        assessments={plan?.assessments ?? review.failure?.assessments ?? []}
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
              <time dateTime={review.expires_at}>{observationTime(review.expires_at)}</time>
            </dd>
          </div>
          <div>
            <dt>Plan identity</dt>
            <dd>
              <code>{review.id}</code>
            </dd>
          </div>
          {plan && (
            <>
              <div>
                <dt>Map revision</dt>
                <dd>
                  {sentence(plan.map_id)}, revision {plan.map_revision}
                </dd>
              </div>
              <div>
                <dt>Planner</dt>
                <dd>
                  <code>{plan.planner_id}</code>
                </dd>
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
              <code>{review.digest}</code>
            </dd>
          </div>
        </dl>
      </details>
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
          Route conditions changed or their current snapshot is unavailable. Prepare a fresh review
          against the current conditions before approval.
        </p>
      )}
      {status !== 'pending' && status !== 'blocked' && (
        <p className="route-note">
          This review is now {status}. Its original plan remains available for inspection.
        </p>
      )}
      <div className="actions">
        {canOperate && plan && (
          <GuardedAction
            label="Approve reviewed route"
            confirmLabel="Confirm route approval"
            consequence={`The source runs the ${plural(review.steps.length, 'reviewed step', 'reviewed steps')} in order${plan.transfers.length > 0 ? ' up to the first change of body, which waits for its own handoff approval' : ''}. The core rechecks the map, route conditions and bodies first.`}
            pending={approving}
            pendingLabel="Approving route…"
            disabled={expired || mapChanged || conditionsChanged || status !== 'pending'}
            confirmDisabled={expired || mapChanged || conditionsChanged || status !== 'pending'}
            onConfirm={onApprove}
          />
        )}
        <button type="button" className="secondary" disabled={approving} onClick={onClose}>
          Close route review
        </button>
      </div>
    </section>
  );
}
