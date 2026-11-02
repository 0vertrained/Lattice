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
  const active = rounds.data?.find((r) => ['active', 'recovery_required'].includes(r.status));
  return (
    <section className="panel inspection-round" aria-labelledby="round-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">A complete warehouse objective</p>
          <h2 id="round-heading">Inspection round</h2>
        </div>
        <span className="status-pill">3 reviewed steps</span>
      </div>
      <p>
        Inspect two stations, retain the camera evidence, and return to charge. A validated image
        with no marker at the dock records an anomaly and continues. Navigation or capture failures
        stop the round.
      </p>
      <ol className="round-steps">
        {(review?.steps ?? steps).map((step, i) => (
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
              <p>
                Execution is held. Review the recovery on the current mission below; approval
                resumes this round.
              </p>
            )}
          </div>
        ))}
      {(prepare.error || approve.error || rounds.error) && (
        <p className="notice error" role="alert">
          {(prepare.error || approve.error || rounds.error)?.message}
        </p>
      )}
    </section>
  );
}
