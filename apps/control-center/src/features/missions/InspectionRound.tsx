import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import { apiClient } from '../../core/api/apiClient';
import { skillCommandSchema } from '../../core/api/schemas';

const stepSchema = z.object({
  title: z.string(),
  command: skillCommandSchema,
  continue_on_missing_marker: z.boolean(),
});
const roundSchema = z.object({
  id: z.string(),
  digest: z.string(),
  steps: z.array(stepSchema),
  expires_at: z.string(),
  status: z.string(),
  current_step: z.number(),
  current_mission_id: z.string().nullable(),
  mission_ids: z.array(z.string()),
  anomaly_count: z.number(),
  route_plan_id: z.string().nullable().optional(),
});
type Round = z.infer<typeof roundSchema>;
const steps = [
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
export function InspectionRound({ canOperate }: { readonly canOperate: boolean }) {
  const client = useQueryClient();
  const [review, setReview] = useState<Round | null>(null);
  const [abandonReview, setAbandonReview] = useState<Round | null>(null);
  const [abandoned, setAbandoned] = useState(false);
  const rounds = useQuery({
    queryKey: ['rounds'],
    queryFn: async () => z.array(roundSchema).parse(await apiClient.request('/rounds')),
    refetchInterval: 2000,
  });
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
    mutationFn: async (p: Round) =>
      roundSchema.parse(
        await apiClient.request(`/rounds/${p.id}/approve`, {
          method: 'POST',
          body: JSON.stringify({ digest: p.digest }),
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
  const currentAbandon = rounds.data?.find((round) => round.id === abandonReview?.id);
  const active = rounds.data?.find((r) => ['active', 'recovery_required'].includes(r.status));
  const displayedSteps = review?.steps ?? active?.steps ?? steps;
  return (
    <section className="panel inspection-round" aria-labelledby="round-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            {active?.route_plan_id
              ? 'Follow the reviewed route objective'
              : 'A complete warehouse objective'}
          </p>
          <h2 id="round-heading">Inspection round</h2>
        </div>
        <span className="status-pill">{displayedSteps.length} reviewed steps</span>
      </div>
      <p>
        {active?.route_plan_id
          ? 'Execute the approved route assignments and retain inspection evidence. The round holds at each body change for an explicit handoff review.'
          : 'Inspect two stations, retain the camera evidence, and return to charge. A validated image with no marker at the dock records an anomaly and continues. Navigation or capture failures stop the round.'}
      </p>
      <ol className="round-steps">
        {displayedSteps.map((step, i) => (
          <li key={step.title}>
            <strong>
              {i + 1}. {step.title}
            </strong>
            <span>
              {step.continue_on_missing_marker
                ? 'Record a missing-marker image and continue'
                : 'Stop the round if this step fails'}
            </span>
          </li>
        ))}
      </ol>
      {canOperate && !active && (
        <div className="actions">
          {!review ? (
            <button type="button" disabled={prepare.isPending} onClick={() => prepare.mutate()}>
              Review inspection round
            </button>
          ) : (
            <>
              <p className="muted">
                Review expires {new Date(review.expires_at).toLocaleTimeString()}. This plan is
                operator-authored.
              </p>
              <button type="button" className="secondary" onClick={() => setReview(null)}>
                Discard review
              </button>
              <button
                type="button"
                disabled={approve.isPending || Date.now() >= Date.parse(review.expires_at)}
                onClick={() => approve.mutate(review)}
              >
                Approve entire round
              </button>
            </>
          )}
        </div>
      )}
      {rounds.data
        ?.filter((r) => r.status !== 'pending' && r.status !== 'invalidated')
        .slice(0, 3)
        .map((r) => (
          <div className="round-progress" key={r.id}>
            <strong>
              {r.status.replaceAll('_', ' ')} · step {r.current_step + 1} of {r.steps.length}
            </strong>
            <span>
              {r.anomaly_count} recorded {r.anomaly_count === 1 ? 'anomaly' : 'anomalies'} ·{' '}
              {r.mission_ids.length} mission attempts
            </span>
            {r.status === 'recovery_required' && (
              <>
                <p>
                  {r.route_plan_id
                    ? 'Execution is held. Review the planned transfer or recovery below. If this route can no longer continue, retire the held round before planning a new objective.'
                    : 'Execution is held. Review the recovery on the current mission below; approval resumes this round.'}
                </p>
                {canOperate && !abandonReview && (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setAbandonReview(r);
                      setAbandoned(false);
                      abandon.reset();
                    }}
                  >
                    Abandon held round
                  </button>
                )}
              </>
            )}
          </div>
        ))}
      {canOperate && abandonReview && (
        <div className="review-box">
          <h3>Retire this held objective?</h3>
          <p>
            Round {abandonReview.id.slice(-8)} will end without completing its remaining steps.
            Recorded observations and approval history are preserved. The source stop fence remains
            in force; abandoning does not authorize new motion or create a replacement plan.
          </p>
          <div className="actions">
            <button
              type="button"
              className="secondary"
              disabled={abandon.isPending}
              onClick={() => {
                setAbandonReview(null);
                abandon.reset();
              }}
            >
              Keep held round
            </button>
            <button
              type="button"
              disabled={
                abandon.isPending ||
                currentAbandon?.status !== 'recovery_required' ||
                currentAbandon.digest !== abandonReview.digest
              }
              onClick={() => abandon.mutate(abandonReview)}
            >
              {abandon.isPending ? 'Abandoning round…' : 'Confirm abandon round'}
            </button>
          </div>
        </div>
      )}
      {abandoned && (
        <p className="notice" role="status">
          Held round abandoned. Its evidence is retained and the source stop fence remains. Prepare
          and review a new objective separately.
        </p>
      )}
      {(prepare.error || approve.error || abandon.error || rounds.error) && (
        <p className="notice error" role="alert">
          {(prepare.error || approve.error || abandon.error || rounds.error)?.message}
        </p>
      )}
    </section>
  );
}
