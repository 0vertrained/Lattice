import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { apiClient } from '../../core/api/apiClient';
import type { Body } from '../../core/api/schemas';
import { useSectionActive } from '../../core/sectionActivity';
import { FenceTimer } from '../guard/FenceTimer';
import { GuardedAction } from '../guard/GuardedAction';
import { useReached } from '../guard/useReached';
import type { HandoffStep } from '../handoff/handoff';
import { RetainedEvidence } from '../handoff/RetainedEvidence';
import { observationTime } from '../memory/observation';
import { StatusChip } from '../status';
import type { RouteConditions } from './conditions';
import type { SemanticMap } from './navigation';
import { CandidateAssessments } from './RouteAssessments';
import { RouteMap, SearchSteps } from './RouteMap';
import { RouteRanking } from './RouteRanking';
import {
  type ReplanRound,
  type RouteReplan,
  replanRoundSchema,
  routeReplanSchema,
} from './replans';
import { routeNames, speed } from './routeNames';

export function ReplanPanel({
  map,
  conditions,
  bodies,
  canOperate,
  conditionsUnavailable,
}: {
  readonly map: SemanticMap;
  readonly conditions: RouteConditions | undefined;
  readonly bodies: readonly Body[];
  readonly canOperate: boolean;
  readonly conditionsUnavailable: boolean;
}) {
  const client = useQueryClient();
  const active = useSectionActive();
  const [roundId, setRoundId] = useState('');
  const [review, setReview] = useState<RouteReplan | null>(null);
  const [approved, setApproved] = useState(false);
  const rounds = useQuery({
    queryKey: ['rounds', 'replan'],
    queryFn: async () => z.array(replanRoundSchema).parse(await apiClient.request('/rounds')),
    enabled: active,
    refetchInterval: 2000,
  });
  const history = useQuery({
    queryKey: ['route-replans'],
    queryFn: async () => z.array(routeReplanSchema).parse(await apiClient.request('/replans')),
    enabled: active,
    refetchInterval: 2000,
    retry: false,
  });
  const refresh = async () => {
    await Promise.all(
      [
        'rounds',
        'missions',
        'route-replans',
        'route-plans',
        'route-conditions',
        'route-transfer-options',
        'handoffs',
        'bodies',
        'audit',
      ].map((key) => client.invalidateQueries({ queryKey: [key] })),
    );
  };
  const prepare = useMutation({
    mutationFn: async (round: ReplanRound) =>
      routeReplanSchema.parse(
        await apiClient.request(`/rounds/${encodeURIComponent(round.id)}/replan-proposal`, {
          method: 'POST',
          body: JSON.stringify({ digest: round.digest }),
        }),
      ),
    onSuccess: async (proposal) => {
      setReview(proposal);
      setApproved(false);
      await refresh();
    },
  });
  const approve = useMutation({
    mutationFn: async (proposal: RouteReplan) =>
      replanRoundSchema.parse(
        await apiClient.request(`/replans/${encodeURIComponent(proposal.id)}/approve`, {
          method: 'POST',
          body: JSON.stringify({ digest: proposal.digest }),
        }),
      ),
    onSuccess: async () => {
      setReview(null);
      setApproved(true);
      await refresh();
    },
    onError: refresh,
  });
  const expired = useReached(review?.expires_at);
  const fenceOpen = useReached(review?.not_before_at);
  const held =
    rounds.data?.filter((round) => round.route_plan_id && round.status === 'recovery_required') ??
    [];
  const selected = held.find((round) => round.id === roundId) ?? held[0];
  const current = history.data?.find((proposal) => proposal.id === review?.id);
  const status = current?.status ?? review?.status;
  const currentRound = rounds.data?.find((round) => round.id === review?.round_id);
  const roundChanged = Boolean(
    review &&
      currentRound &&
      (currentRound.digest !== review.round_digest || currentRound.status !== 'recovery_required'),
  );
  const conditionsChanged = Boolean(
    review &&
      (conditionsUnavailable ||
        !conditions ||
        review.conditions_revision !== conditions.revision ||
        (review.plan && review.plan.map_digest !== conditions.map_digest)),
  );
  const mapChanged = Boolean(
    review?.plan && (review.plan.map_id !== map.id || review.plan.map_revision !== map.revision),
  );
  const names = routeNames(map, bodies);
  const { bodyName, placeName } = names;
  const liveSource = bodies.find((body) => body.id === review?.source_body_id);
  const error = prepare.error ?? approve.error ?? rounds.error ?? history.error;
  const blockedApproval =
    expired ||
    !fenceOpen ||
    conditionsChanged ||
    mapChanged ||
    roundChanged ||
    !currentRound ||
    status !== 'pending';
  return (
    <section className="plate route-replanning" aria-labelledby="route-replanning-heading">
      <header className="plate-head">
        <div>
          <h2 id="route-replanning-heading">Continue a held objective</h2>
          <p className="note">A fresh review of the remaining route; completed work is kept</p>
        </div>
      </header>
      <div className="plate-body">
        <p className="route-note">
          Prepare a new route for the remaining work while keeping the original destination,
          completed steps and observation history. The objective stays held until an operator
          approves the exact new review. A later change of body still needs its own handoff
          approval.
        </p>
        {!canOperate && (
          <p className="route-note">
            Viewer access: inspect saved continuity reviews and retained evidence. An operator
            prepares and approves a replacement route.
          </p>
        )}
        {canOperate &&
          !review &&
          (held.length ? (
            <div className="route-controls">
              <label>
                Held route objective
                <select
                  value={selected?.id ?? ''}
                  disabled={prepare.isPending}
                  onChange={(event) => {
                    setRoundId(event.target.value);
                    prepare.reset();
                    approve.reset();
                    setApproved(false);
                  }}
                >
                  {held.map((round) => (
                    <option key={round.id} value={round.id}>
                      Round {round.id.slice(-8)}, {round.current_step} of {round.steps.length} steps
                      completed
                    </option>
                  ))}
                </select>
              </label>
              <p className="route-note">
                The source must be fresh and localized at a known place. Preparing a review moves
                nothing and discards no evidence.
              </p>
              <button
                type="button"
                disabled={prepare.isPending || !selected || conditionsUnavailable || !conditions}
                onClick={() => {
                  if (selected) {
                    approve.reset();
                    setApproved(false);
                    prepare.mutate(selected);
                  }
                }}
              >
                {prepare.isPending ? 'Preparing updated route…' : 'Prepare updated route review'}
              </button>
            </div>
          ) : (
            <p className="empty-state">No route objective is currently held for a new plan.</p>
          ))}
      </div>
      {review && (
        <div className="review-box replan-review">
          <div className="card-title-row">
            <h3>
              {review.plan ? 'Review the remaining route' : 'Remaining route cannot be approved'}
            </h3>
            {status && <StatusChip status={status} />}
          </div>
          <p>
            <strong>Original objective:</strong>{' '}
            {placeName(review.original_objective.route.source_place_id)} to{' '}
            {placeName(review.original_objective.route.destination_place_id)}
            {review.original_objective.inspect_destination
              ? ', including the destination inspection'
              : ''}
            .
          </p>
          <p>
            <strong>Continue from:</strong> {bodyName(review.source_body_id)} at{' '}
            {review.source_place_id ? placeName(review.source_place_id) : 'an unconfirmed place'}.
          </p>
          {liveSource && (
            <p className="route-note">
              Latest source telemetry: {liveSource.status.replaceAll('_', ' ')}, heartbeat{' '}
              {observationTime(liveSource.last_seen)}.
              {liveSource.pose
                ? ` Reported at x ${liveSource.pose.x.toFixed(2)} m, y ${liveSource.pose.y.toFixed(2)} m${liveSource.pose.z != null ? `, z ${liveSource.pose.z.toFixed(2)} m` : ', elevation not reported'}.`
                : ' No localization is reported.'}{' '}
              This live update does not change the frozen review; the core rechecks it at approval.
            </p>
          )}
          <dl className="route-readouts">
            <div>
              <dt>Completed steps kept</dt>
              <dd className="figures">{review.completed_steps.length}</dd>
            </div>
            <div>
              <dt>Remaining reviewed steps</dt>
              <dd className="figures">{review.remaining_steps.length}</dd>
            </div>
            <div>
              <dt>Retained observations</dt>
              <dd className="figures">{review.retained_observation_ids.length}</dd>
            </div>
          </dl>
          {review.blocked_segment_ids.length > 0 && (
            <p className="route-note">
              This review leaves out the reported blocked{' '}
              {review.blocked_segment_ids.length === 1 ? 'segment' : 'segments'}{' '}
              {review.blocked_segment_ids.map(names.segmentName).join(', ')}, from condition
              revision {review.conditions_revision}.
            </p>
          )}
          {review.failure && <p className="notice error">{review.failure.message}</p>}
          {review.plan && (
            <>
              <RouteMap
                map={map}
                plan={review.plan}
                playKey={review.id}
                blockedSegmentIds={review.blocked_segment_ids}
                placeName={placeName}
                bodyName={bodyName}
              />
              <RouteRanking
                plan={review.plan}
                map={map}
                placeName={placeName}
                bodyName={bodyName}
              />
              <SearchSteps
                plan={review.plan}
                placeName={placeName}
                bodyName={bodyName}
                segmentName={names.segmentName}
              />
              <ul className="route-explanation">
                {review.plan.explanation.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
              <p className="route-note">
                {review.plan.distance_m.toFixed(2)} m of straight lines between places, the
                planner’s cost rather than measured travel. Any planned change of body still needs
                its own review.
              </p>
            </>
          )}
          <h4>Completed work kept</h4>
          {review.completed_steps.length ? (
            <ReplanSteps steps={review.completed_steps} start={1} />
          ) : (
            <p className="route-note">No steps had completed before this hold.</p>
          )}
          <h4>New remaining assignments</h4>
          {review.remaining_steps.length ? (
            <ReplanSteps
              steps={review.remaining_steps}
              start={review.completed_steps.length + 1}
              bodyIds={review.step_body_ids}
              bodyName={bodyName}
            />
          ) : (
            <p className="route-note">
              No executable replacement steps are available in this review.
            </p>
          )}
          <CandidateAssessments
            assessments={review.plan?.assessments ?? review.failure?.assessments ?? []}
            bodyName={bodyName}
            placeName={placeName}
            map={map}
          />
          <details className="route-binding">
            <summary>Retained evidence and mission history</summary>
            <p className="route-note">
              Previous attempts and accepted observations stay attached to the same objective.
            </p>
            {review.retained_observation_ids.map((id) => (
              <RetainedEvidence key={id} observationId={id} imageHash={undefined} />
            ))}
            {review.retained_observation_ids.length === 0 && (
              <p className="route-note">No observations were retained at this boundary.</p>
            )}
            <ul className="route-retained-missions">
              {review.retained_mission_ids.map((id) => (
                <li key={id}>
                  <code>{id}</code>
                </li>
              ))}
            </ul>
          </details>
          <details className="route-binding">
            <summary>Updated review binding and execution fence</summary>
            <dl className="handoff-facts">
              <div>
                <dt>Condition revision</dt>
                <dd className="figures">{review.conditions_revision}</dd>
              </div>
              <div>
                <dt>Review expires</dt>
                <dd>{observationTime(review.expires_at)}</dd>
              </div>
              <div>
                <dt>Source execution fence ends</dt>
                <dd>{observationTime(review.not_before_at)}</dd>
              </div>
              <div>
                <dt>Same objective</dt>
                <dd>
                  <code>{review.round_id}</code>
                </dd>
              </div>
              <div className="full-width">
                <dt>Previous round SHA-256</dt>
                <dd>
                  <code>{review.round_digest}</code>
                </dd>
              </div>
              <div className="full-width">
                <dt>Updated proposal SHA-256</dt>
                <dd>
                  <code>{review.digest}</code>
                </dd>
              </div>
            </dl>
          </details>
          {expired && (
            <p className="notice error" role="status">
              This updated review expired. Prepare a fresh review of the held objective.
            </p>
          )}
          {conditionsChanged && (
            <p className="notice error" role="status">
              Route conditions changed or are unavailable. Prepare a fresh continuity review before
              approval.
            </p>
          )}
          {mapChanged && (
            <p className="notice error" role="status">
              The configured map revision changed. This updated route can no longer be approved.
            </p>
          )}
          {roundChanged && (
            <p className="notice error" role="status">
              The held objective changed after this review. Its previous digest cannot authorize
              continuation.
            </p>
          )}
          {status !== 'pending' && status !== 'blocked' && (
            <p className="route-note">
              This continuity review is now {status}. Its original content remains available for
              inspection.
            </p>
          )}
          {review.plan && status === 'pending' && (
            <FenceTimer
              from={review.created_at}
              until={review.not_before_at}
              what="This continuation"
            />
          )}
          <p className="route-note">
            Approval rechecks the source’s position, capabilities, battery, availability and
            heartbeat after the stop fence. A clear report alone never resumes execution.
          </p>
          <div className="actions">
            {canOperate && review.plan && (
              <GuardedAction
                label="Approve reviewed continuation"
                confirmLabel="Confirm continuation"
                consequence={`The held objective resumes on this route with ${review.remaining_steps.length} remaining ${review.remaining_steps.length === 1 ? 'step' : 'steps'}; completed work and evidence are kept. The core rechecks the source first.`}
                pending={approve.isPending}
                pendingLabel="Approving updated route…"
                disabled={blockedApproval}
                confirmDisabled={blockedApproval}
                onConfirm={() => approve.mutate(review)}
              />
            )}
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
              Close updated route review
            </button>
          </div>
        </div>
      )}
      {(approved || error) && (
        <div className="plate-body">
          {approved && (
            <p className="notice" role="status">
              The updated route was approved for the same objective. Completed work and evidence are
              kept; any upcoming change of body still needs its own approval.
            </p>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error.message}
            </p>
          )}
        </div>
      )}
      {history.data && history.data.length > 0 && (
        <div className="route-plan-history plate-body">
          <h3>Continuity reviews</h3>
          <ul>
            {history.data.slice(0, 6).map((proposal) => (
              <li key={proposal.id}>
                <div>
                  <strong>
                    Continue to {placeName(proposal.original_objective.route.destination_place_id)}
                  </strong>
                  <small>
                    Condition revision {proposal.conditions_revision},{' '}
                    <time dateTime={proposal.created_at}>
                      {observationTime(proposal.created_at)}
                    </time>
                  </small>
                </div>
                <StatusChip status={proposal.status} />
                <button
                  type="button"
                  className="secondary"
                  disabled={prepare.isPending || approve.isPending}
                  onClick={() => {
                    setReview(proposal);
                    prepare.reset();
                    approve.reset();
                    setApproved(false);
                  }}
                >
                  View continuity review
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ReplanSteps({
  steps,
  start,
  bodyIds,
  bodyName,
}: {
  readonly steps: readonly HandoffStep[];
  readonly start: number;
  readonly bodyIds?: readonly string[];
  readonly bodyName?: (id: string) => string;
}) {
  return (
    <ol className="route-assignments" start={start}>
      {steps.map((step, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: The signed review freezes step order, including repeated commands.
        <li key={`${index}-${step.title}`}>
          <strong>{step.title}</strong>
          {bodyIds && bodyName && <span>{bodyName(bodyIds[index] ?? '')}</span>}
          {step.command.type === 'traverse_route' && (
            <small>
              Needs {step.command.traversal.required_capabilities.join(', ')}, at most{' '}
              {speed(step.command.traversal.max_speed_mps)}
            </small>
          )}
        </li>
      ))}
    </ol>
  );
}
