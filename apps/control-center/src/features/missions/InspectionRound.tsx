import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '../../core/api/apiClient';
import { GuardedAction } from '../guard/GuardedAction';
import { StatusChip } from '../status';
import { type Round, type RoundStep, roundSchema, useRounds } from './rounds';

const steps: readonly RoundStep[] = [
  {
    title: 'Inspect the bay safety station',
    command: { type: 'inspect', location: 'inspection_bay' },
    continue_on_missing_marker: false,
  },
  {
    title: 'Check the loading dock for a safety marker',
    command: { type: 'inspect', location: 'loading_dock' },
    continue_on_missing_marker: true,
  },
  {
    title: 'Return to the charging station',
    command: { type: 'navigate', destination: 'charging_station', max_speed_mps: 0.3 },
    continue_on_missing_marker: false,
  },
];

type StepState = 'done' | 'current' | 'held' | 'next';
const stepWords: Record<StepState, string> = {
  done: 'Done',
  current: 'In progress',
  held: 'Held for review',
  next: 'Not started',
};
function stepState(round: Round | undefined, index: number): StepState | undefined {
  if (!round) return undefined;
  if (index < round.current_step) return 'done';
  if (index > round.current_step) return 'next';
  return round.status === 'recovery_required' ? 'held' : 'current';
}
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function InspectionRound({ canOperate }: { readonly canOperate: boolean }) {
  const client = useQueryClient();
  const [review, setReview] = useState<Round | null>(null);
  const [abandonReview, setAbandonReview] = useState<Round | null>(null);
  const [abandoned, setAbandoned] = useState(false);
  const rounds = useRounds(true, 2_000);
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['rounds'] });
    await client.invalidateQueries({ queryKey: ['missions'] });
  };
  const prepare = useMutation({
    mutationFn: async () =>
      roundSchema.parse(
        await apiClient.request('/rounds', { method: 'POST', body: JSON.stringify({ steps }) }),
      ),
    onSuccess: setReview,
  });
  const approve = useMutation({
    mutationFn: async (round: Round) =>
      roundSchema.parse(
        await apiClient.request(`/rounds/${round.id}/approve`, {
          method: 'POST',
          body: JSON.stringify({ digest: round.digest }),
        }),
      ),
    onSuccess: async () => {
      setReview(null);
      await refresh();
    },
  });
  const abandon = useMutation({
    mutationFn: async (round: Round) =>
      roundSchema.parse(
        await apiClient.request(`/rounds/${encodeURIComponent(round.id)}/abandon`, {
          method: 'POST',
          body: JSON.stringify({ digest: round.digest }),
        }),
      ),
    onSuccess: async () => {
      setAbandonReview(null);
      setAbandoned(true);
      await refresh();
      await client.invalidateQueries({ queryKey: ['handoffs'] });
      await client.invalidateQueries({ queryKey: ['route-plans'] });
      await client.invalidateQueries({ queryKey: ['route-transfer-options'] });
    },
    onError: refresh,
  });
  const active = rounds.data?.find((r) => ['active', 'recovery_required'].includes(r.status));
  const sheet = review?.steps ?? active?.steps ?? steps;
  const shownRound = review ? undefined : active;
  const recent =
    rounds.data?.filter((r) => r.status !== 'pending' && r.status !== 'invalidated').slice(0, 3) ??
    [];
  const expired = review !== null && Date.now() >= Date.parse(review.expires_at);
  const failure = prepare.error ?? approve.error ?? abandon.error ?? rounds.error;

  return (
    <section className="plate round-plate" aria-labelledby="round-heading">
      <header className="plate-head">
        <div>
          <h2 id="round-heading">Inspection round</h2>
          <p className="note">
            {active?.route_plan_id
              ? 'Following the reviewed route objective'
              : 'A complete warehouse objective'}
          </p>
        </div>
        {shownRound ? (
          <StatusChip status={shownRound.status} />
        ) : (
          <span className="note figures">{plural(sheet.length, 'step', 'steps')}</span>
        )}
      </header>
      <p className="round-intro">
        {active?.route_plan_id
          ? 'The round runs the approved route assignments and keeps each inspection’s evidence. It holds at every body change for an explicit handoff review.'
          : 'Inspect two stations, keep the camera evidence, and return to charge. A clear image without a marker at the dock is recorded as an anomaly and the round continues. A failed navigation or capture stops the round.'}
      </p>
      <ol className="round-sheet">
        {sheet.map((step, index) => {
          const state = stepState(shownRound, index);
          return (
            <li key={step.title} data-state={state}>
              <span className="round-number figures" aria-hidden="true">
                {index + 1}
              </span>
              <div>
                <strong>{step.title}</strong>
                <span>
                  {step.continue_on_missing_marker
                    ? 'A missing marker is recorded and the round continues'
                    : 'The round stops if this step fails'}
                </span>
              </div>
              {state && <span className="round-step-state">{stepWords[state]}</span>}
            </li>
          );
        })}
      </ol>

      {canOperate && !active && (
        <div className="round-actions">
          {!review ? (
            <button type="button" disabled={prepare.isPending} onClick={() => prepare.mutate()}>
              {prepare.isPending ? 'Preparing review…' : 'Review inspection round'}
            </button>
          ) : (
            <div className="review-box">
              <h3>Review this round</h3>
              <dl>
                <div>
                  <dt>Plan digest</dt>
                  <dd>
                    <code>{review.digest}</code>
                  </dd>
                </div>
                <div>
                  <dt>Review expires</dt>
                  <dd className="figures">{new Date(review.expires_at).toLocaleTimeString()}</dd>
                </div>
              </dl>
              <p className="note">
                This plan is operator-authored. Approval applies to this exact digest.
              </p>
              {expired && <p role="status">This review expired. Discard it and review again.</p>}
              <div className="actions">
                <GuardedAction
                  label="Approve entire round"
                  confirmLabel="Confirm round approval"
                  consequence={`Approving sends all ${plural(review.steps.length, 'step', 'steps')} to the fleet, in order, without asking again between them.`}
                  pending={approve.isPending}
                  pendingLabel="Approving round…"
                  disabled={expired}
                  confirmDisabled={expired}
                  onConfirm={() => approve.mutate(review)}
                />
                <button
                  type="button"
                  className="secondary"
                  disabled={approve.isPending}
                  onClick={() => setReview(null)}
                >
                  Discard review
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {recent.length > 0 && (
        <div className="round-log">
          <h3>Recent rounds</h3>
          {recent.map((round) => {
            const held = round.status === 'recovery_required';
            const current = rounds.data?.find((r) => r.id === abandonReview?.id);
            return (
              <article key={round.id} className="round-entry" data-held={held ? '' : undefined}>
                <div className="round-entry-head">
                  <StatusChip status={round.status} />
                  <code>{round.id.slice(-8)}</code>
                </div>
                <p className="round-facts figures">
                  <span>
                    Step {Math.min(round.current_step + 1, round.steps.length)} of{' '}
                    {round.steps.length}
                  </span>
                  <span>{plural(round.anomaly_count, 'anomaly', 'anomalies')} recorded</span>
                  <span>
                    {plural(round.mission_ids.length, 'mission attempt', 'mission attempts')}
                  </span>
                </p>
                {held && (
                  <>
                    <p>
                      {round.route_plan_id
                        ? 'Execution is held. Review the planned transfer, or continue the held objective from the routes section with another reviewed route. Retire the round when this objective should end.'
                        : 'Execution is held. Review the recovery on the current mission in the missions section; approving it resumes this round.'}
                    </p>
                    {canOperate && (
                      <GuardedAction
                        danger
                        label="Abandon held round"
                        confirmLabel="Confirm abandon round"
                        cancelLabel="Keep held round"
                        consequence={`Round ${round.id.slice(-8)} ends without completing its remaining steps. Recorded observations and approval history are kept. The source stop fence stays in force; abandoning does not authorize new motion or create a replacement plan.`}
                        pending={abandon.isPending}
                        pendingLabel="Abandoning round…"
                        confirmDisabled={
                          current?.status !== 'recovery_required' ||
                          current.digest !== abandonReview?.digest
                        }
                        onArm={() => {
                          setAbandonReview(round);
                          setAbandoned(false);
                          abandon.reset();
                        }}
                        onCancel={() => {
                          setAbandonReview(null);
                          abandon.reset();
                        }}
                        onConfirm={() => {
                          if (abandonReview) abandon.mutate(abandonReview);
                        }}
                      />
                    )}
                  </>
                )}
              </article>
            );
          })}
        </div>
      )}
      {abandoned && (
        <p className="notice" role="status">
          Held round abandoned. Its evidence is retained and the source stop fence remains. Prepare
          and review a new objective separately.
        </p>
      )}
      {failure && (
        <p className="notice error" role="alert">
          {failure.message}
        </p>
      )}
    </section>
  );
}
