import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { apiClient } from '../../core/api/apiClient';
import type { Body, Mission } from '../../core/api/schemas';
import { useSectionActive } from '../../core/sectionActivity';
import { FenceTimer } from '../guard/FenceTimer';
import { GuardedAction } from '../guard/GuardedAction';
import { useReached } from '../guard/useReached';
import { observationTime } from '../memory/observation';
import { StatusChip } from '../status';
import {
  type Handoff,
  type HandoffStep,
  handoffRoundSchema,
  handoffSchema,
  transferOptionsSchema,
} from './handoff';
import { RetainedEvidence } from './RetainedEvidence';

const placeLabel = (id: string) => {
  const words = id.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export function HandoffPanel({
  bodies,
  missions,
  canOperate,
}: {
  readonly bodies: readonly Body[];
  readonly missions: readonly Mission[];
  readonly canOperate: boolean;
}) {
  const client = useQueryClient();
  const active = useSectionActive();
  const [roundId, setRoundId] = useState('');
  const [targetId, setTargetId] = useState('');
  const [review, setReview] = useState<Handoff | null>(null);
  const [approved, setApproved] = useState(false);
  const rounds = useQuery({
    queryKey: ['rounds', 'handoff'],
    queryFn: async () => z.array(handoffRoundSchema).parse(await apiClient.request('/rounds')),
    enabled: active,
    refetchInterval: 2000,
  });
  const history = useQuery({
    queryKey: ['handoffs'],
    queryFn: async () => z.array(handoffSchema).parse(await apiClient.request('/handoffs')),
    enabled: active,
    refetchInterval: 2000,
  });
  const refresh = async () => {
    await Promise.all(
      ['rounds', 'missions', 'handoffs', 'audit', 'bodies', 'route-transfer-options'].map((key) =>
        client.invalidateQueries({ queryKey: [key] }),
      ),
    );
  };
  const prepare = useMutation({
    mutationFn: async ({ round, target }: { round: string; target: string }) =>
      handoffSchema.parse(
        await apiClient.request(`/rounds/${encodeURIComponent(round)}/handoff-proposal`, {
          method: 'POST',
          body: JSON.stringify({ target_body_id: target }),
        }),
      ),
    onSuccess: async (proposal) => {
      setReview(proposal);
      setApproved(false);
      await refresh();
    },
  });
  const approve = useMutation({
    mutationFn: async (proposal: Handoff) =>
      handoffSchema.parse(
        await apiClient.request(`/handoffs/${encodeURIComponent(proposal.id)}/approve`, {
          method: 'POST',
          body: JSON.stringify({ digest: proposal.digest }),
        }),
      ),
    onSuccess: async () => {
      setReview(null);
      setApproved(true);
      await refresh();
    },
    onError: async () => {
      await refresh();
    },
  });
  const candidates =
    rounds.data?.filter((round) => ['active', 'recovery_required'].includes(round.status)) ?? [];
  const selectedRound = candidates.find((round) => round.id === roundId) ?? candidates[0];
  const sourceId =
    selectedRound?.assigned_body_id ??
    missions.find((mission) => mission.id === selectedRound?.current_mission_id)?.assigned_body_id;
  const plannedTransfer = useQuery({
    queryKey: ['route-transfer-options', selectedRound?.id],
    queryFn: async () =>
      transferOptionsSchema.parse(
        await apiClient.request(
          `/rounds/${encodeURIComponent(selectedRound?.id ?? '')}/transfer-options`,
        ),
      ),
    enabled: active && Boolean(selectedRound?.route_plan_id),
    refetchInterval: 2000,
  });
  const routeBound = Boolean(selectedRound?.route_plan_id);
  const recommendation = plannedTransfer.data;
  const targets = bodies.filter(
    (body) =>
      body.id !== sourceId &&
      (!routeBound ||
        (recommendation?.required && body.id === recommendation.recommended_target_body_id)),
  );
  const selectedTarget =
    targets.find((body) => body.id === targetId) ?? (routeBound ? targets[0] : undefined);
  const bodyName = (id: string) => bodies.find((body) => body.id === id)?.display_name ?? id;
  const expired = useReached(review?.expires_at);
  const fenceOpen = useReached(review?.not_before_at);
  const currentReview = history.data?.find((entry) => entry.id === review?.id);
  const invalidated =
    review !== null && currentReview !== undefined && currentReview.status !== 'pending';
  const error =
    prepare.error ?? approve.error ?? rounds.error ?? history.error ?? plannedTransfer.error;
  return (
    <section className="plate handoff-panel" aria-labelledby="handoff-heading">
      <header className="plate-head">
        <div>
          <h2 id="handoff-heading">Reviewed handoff</h2>
          <p className="note">Continue an objective on another body</p>
        </div>
      </header>
      <div className="plate-body">
        <p className="handoff-note">
          Hand the rest of an inspection round to another body, keeping completed steps and camera
          evidence. The receiving body must acknowledge the reviewed context.
        </p>
        {!canOperate && (
          <p className="handoff-note">
            Viewer access: inspect handoff history and retained evidence. An operator prepares and
            approves transfers.
          </p>
        )}
        {routeBound && recommendation && (
          <div className="route-transfer-recommendation" role="status">
            <h3>
              {recommendation.required
                ? 'Recommended capability transfer'
                : 'Route transfer status'}
            </h3>
            <p>{recommendation.reason}</p>
            {recommendation.transfer_place_id && (
              <p>
                Transfer point: <strong>{placeLabel(recommendation.transfer_place_id)}</strong>
              </p>
            )}
            {recommendation.recommended_target_body_id && (
              <p>
                Planned receiving body:{' '}
                <strong>{bodyName(recommendation.recommended_target_body_id)}</strong>
              </p>
            )}
            {recommendation.blocking_reasons.length > 0 && (
              <ul>
                {recommendation.blocking_reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            <p className="handoff-note">
              This recommendation does not pause a body or authorize motion. An operator must
              prepare and approve the exact transfer.
            </p>
          </div>
        )}
        {canOperate &&
          !review &&
          (candidates.length > 0 ? (
            <div className="handoff-selectors">
              <label>
                Round to continue
                <select
                  value={selectedRound?.id ?? ''}
                  onChange={(event) => {
                    setRoundId(event.target.value);
                    setTargetId('');
                    prepare.reset();
                    approve.reset();
                  }}
                >
                  {candidates.map((round) => (
                    <option key={round.id} value={round.id}>
                      Round {round.id.slice(-8)}, step {round.current_step + 1} of{' '}
                      {round.steps.length}
                    </option>
                  ))}
                </select>
              </label>
              <p className="handoff-note">
                Source body: <strong>{sourceId ? bodyName(sourceId) : 'No source assigned'}</strong>
              </p>
              <label>
                Receiving body
                <select
                  value={selectedTarget?.id ?? ''}
                  onChange={(event) => {
                    setTargetId(event.target.value);
                    prepare.reset();
                    approve.reset();
                  }}
                >
                  <option value="">
                    {routeBound ? 'Awaiting planned transfer' : 'Select another body'}
                  </option>
                  {targets.map((body) => (
                    <option key={body.id} value={body.id}>
                      {body.display_name} ({body.status.replaceAll('_', ' ')}, {body.battery}%
                      battery)
                    </option>
                  ))}
                </select>
              </label>
              <p className="handoff-note">
                Preparing a review holds the round and retires the source command. It stays held if
                you close the review. The core checks the target’s freshness, capabilities, battery
                and availability again at approval.
              </p>
              <button
                type="button"
                disabled={
                  prepare.isPending ||
                  !selectedRound ||
                  !sourceId ||
                  !selectedTarget ||
                  (routeBound && !recommendation?.ready)
                }
                onClick={() => {
                  if (selectedRound && selectedTarget) {
                    approve.reset();
                    setApproved(false);
                    prepare.mutate({ round: selectedRound.id, target: selectedTarget.id });
                  }
                }}
              >
                {prepare.isPending ? 'Preparing handoff…' : 'Pause source and review handoff'}
              </button>
            </div>
          ) : (
            <p className="empty-state">
              Start an inspection round to review a transfer between bodies.
            </p>
          ))}
      </div>
      {review && (
        <div className="review-box handoff-review">
          <h3>Review this exact continuation</h3>
          <HandoffDetails handoff={review} bodyName={bodyName} />
          <dl className="handoff-facts">
            <div>
              <dt>Earliest approval</dt>
              <dd>
                <time dateTime={review.not_before_at}>{observationTime(review.not_before_at)}</time>
              </dd>
            </div>
            <div>
              <dt>Review expires</dt>
              <dd>
                <time dateTime={review.expires_at}>{observationTime(review.expires_at)}</time>
              </dd>
            </div>
          </dl>
          {!expired && !invalidated && (
            <FenceTimer from={review.created_at} until={review.not_before_at} what="This handoff" />
          )}
          {!fenceOpen && (
            <p className="handoff-note">
              The fence covers the source command’s signed execution window plus the stop margin.
            </p>
          )}
          {expired && (
            <p className="notice error" role="status">
              This review expired. Close it and prepare a new review; the round remains held.
            </p>
          )}
          {invalidated && (
            <p className="notice error" role="status">
              This proposal is now {currentReview.status}. Close this review to refresh the handoff
              state.
            </p>
          )}
          <div className="actions">
            {canOperate && (
              <GuardedAction
                label="Approve reviewed handoff"
                confirmLabel="Confirm handoff"
                consequence={`${bodyName(review.target_body_id)} receives the ${review.remaining_steps.length} remaining ${review.remaining_steps.length === 1 ? 'step' : 'steps'} and the retained evidence; ${bodyName(review.source_body_id)} stays stopped. The core rechecks the receiving body first.`}
                pending={approve.isPending}
                pendingLabel="Approving handoff…"
                disabled={expired || !fenceOpen || invalidated}
                confirmDisabled={expired || !fenceOpen || invalidated}
                onConfirm={() => approve.mutate(review)}
              />
            )}
            <button
              className="secondary"
              type="button"
              disabled={approve.isPending}
              onClick={() => {
                setReview(null);
                prepare.reset();
                approve.reset();
              }}
            >
              Close review
            </button>
          </div>
        </div>
      )}
      {(approved || error) && (
        <div className="plate-body">
          {approved && (
            <p className="notice success" role="status">
              Handoff approved. Follow the receiving body’s context acknowledgement and remaining
              missions below.
            </p>
          )}
          {error && (
            <p className="notice error" role="alert">
              {error.message}
            </p>
          )}
        </div>
      )}
      <div className="handoff-history">
        <h3>Handoff history</h3>
        {history.isPending && <p role="status">Loading handoff history…</p>}
        {history.data?.length === 0 && (
          <p className="empty-state">No handoffs have been proposed.</p>
        )}
        <ul>
          {history.data?.slice(0, 5).map((handoff) => (
            <li key={handoff.id}>
              <div className="card-title-row">
                <div>
                  <strong>
                    {bodyName(handoff.source_body_id)} to {bodyName(handoff.target_body_id)}
                  </strong>
                  <small>
                    {handoff.context_acknowledged_at
                      ? `Context acknowledged ${observationTime(handoff.context_acknowledged_at)}`
                      : handoff.status === 'approved'
                        ? 'Waiting for the receiving body to acknowledge the context'
                        : 'Execution waits for explicit approval'}
                  </small>
                </div>
                <StatusChip status={handoff.status} />
              </div>
              <time dateTime={handoff.created_at}>{observationTime(handoff.created_at)}</time>
              <details>
                <summary>Steps, evidence and approval record</summary>
                <HandoffDetails handoff={handoff} bodyName={bodyName} />
              </details>
              {canOperate && handoff.status === 'pending' && handoff.id !== review?.id && (
                <button
                  className="secondary"
                  type="button"
                  onClick={() => {
                    setReview(handoff);
                    prepare.reset();
                    approve.reset();
                    setApproved(false);
                  }}
                >
                  Open handoff review
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function HandoffDetails({
  handoff,
  bodyName,
}: {
  readonly handoff: Handoff;
  readonly bodyName: (id: string) => string;
}) {
  return (
    <>
      <dl className="handoff-facts">
        <div>
          <dt>Source body</dt>
          <dd>
            {bodyName(handoff.source_body_id)}
            <br />
            <code>{handoff.source_body_id}</code>
          </dd>
        </div>
        <div>
          <dt>Receiving body</dt>
          <dd>
            {bodyName(handoff.target_body_id)}
            <br />
            <code>{handoff.target_body_id}</code>
          </dd>
        </div>
      </dl>
      <h4>Completed steps ({handoff.completed_steps.length})</h4>
      {handoff.completed_steps.length > 0 ? (
        <StepList steps={handoff.completed_steps} start={1} />
      ) : (
        <p className="handoff-note">No completed steps yet.</p>
      )}
      <h4>Remaining steps ({handoff.remaining_steps.length})</h4>
      <StepList steps={handoff.remaining_steps} start={handoff.completed_steps.length + 1} />
      <h4>Retained observations ({handoff.retained_observation_ids.length})</h4>
      {handoff.retained_observation_ids.length === 0 && (
        <p className="handoff-note">No camera observations have been recorded in this round yet.</p>
      )}
      {handoff.retained_observation_ids.map((id) => (
        <RetainedEvidence
          key={id}
          observationId={id}
          imageHash={
            handoff.context.observations.find((observation) => observation.observation_id === id)
              ?.image_sha256
          }
        />
      ))}
      <details className="observation-provenance">
        <summary>Immutable approval binding</summary>
        <dl className="handoff-facts">
          <div>
            <dt>Round</dt>
            <dd>
              <code>{handoff.round_id}</code>
            </dd>
          </div>
          <div>
            <dt>Source mission</dt>
            <dd>
              <code>{handoff.source_mission_id}</code>
            </dd>
          </div>
          <div>
            <dt>Resumed mission</dt>
            <dd>
              {handoff.resumed_mission_id ? (
                <code>{handoff.resumed_mission_id}</code>
              ) : (
                'Not dispatched'
              )}
            </dd>
          </div>
          <div>
            <dt>Approved at</dt>
            <dd>
              {handoff.approved_at ? observationTime(handoff.approved_at) : 'Awaiting approval'}
            </dd>
          </div>
          <div className="full-width">
            <dt>Proposal SHA-256</dt>
            <dd>
              <code>{handoff.digest}</code>
            </dd>
          </div>
          <div className="full-width">
            <dt>Shared context SHA-256</dt>
            <dd>
              <code>{handoff.context.digest}</code>
            </dd>
          </div>
        </dl>
      </details>
    </>
  );
}

function StepList({
  steps,
  start,
}: {
  readonly steps: readonly HandoffStep[];
  readonly start: number;
}) {
  return (
    <ol className="handoff-step-list" start={start}>
      {steps.map((step, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: Reviewed step order is immutable and identical commands may repeat.
        <li key={`${start + index}-${step.title}`}>
          <strong>{step.title}</strong>
          <small>
            {step.command.type === 'traverse_route'
              ? `${placeLabel(step.command.traversal.from.id)} to ${placeLabel(step.command.traversal.to.id)}, needs ${step.command.traversal.required_capabilities.join(', ')}, at most ${Number(step.command.traversal.max_speed_mps.toFixed(2))} m/s`
              : step.command.type === 'inspect'
                ? `Inspect at ${placeLabel(step.command.location)}`
                : step.command.type === 'navigate'
                  ? `Navigate to ${placeLabel(step.command.destination)}, at most ${Number(step.command.max_speed_mps.toFixed(2))} m/s`
                  : JSON.stringify(step.command)}
          </small>
          <small>
            {step.continue_on_missing_marker
              ? 'Record a missing-marker image and continue'
              : 'Stop the round if this step fails'}
          </small>
        </li>
      ))}
    </ol>
  );
}
