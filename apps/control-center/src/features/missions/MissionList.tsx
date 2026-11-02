import { useState } from 'react';
import { apiClient } from '../../core/api/apiClient';
import { useApproveProposal } from '../../core/api/queries';
import type { Body, Mission, Proposal } from '../../core/api/schemas';

interface MissionListProps {
  readonly missions: readonly Mission[];
  readonly bodies: readonly Body[];
}

export function MissionList({ missions, bodies }: MissionListProps) {
  const bodyNames = new Map(bodies.map((body) => [body.id, body.display_name]));

  return (
    <section className="panel mission-panel" aria-labelledby="missions-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Durable objectives</p>
          <h2 id="missions-title">Missions</h2>
        </div>
        <span>{missions.length} total</span>
      </div>

      <div className="mission-list">
        {missions.map((mission) => (
          <article key={mission.id}>
            <div className="card-title-row">
              <div>
                <strong>{mission.title}</strong>
                <small>{bodyNames.get(mission.assigned_body_id ?? '') ?? 'Awaiting body'}</small>
              </div>
              <span className={`status-pill ${mission.status}`}>
                {mission.status.replaceAll('_', ' ')}
              </span>
            </div>
            <div className="command-summary">
              <code>{mission.command.type}</code>
              <span>{mission.active_command_id ?? 'No active command'}</span>
            </div>
            <progress value={mission.progress_pct} max={100} />
            {mission.evidence && (
              <figure className="inspection-evidence">
                <img
                  src={`data:image/jpeg;base64,${mission.evidence.image_base64}`}
                  width={320}
                  height={240}
                  alt={`Camera evidence for ${mission.title}; ${mission.evidence.detections.length} safety markers detected`}
                />
                <figcaption>
                  {mission.evidence.detections.length === 0
                    ? 'No supported marker detected.'
                    : mission.evidence.detections
                        .map((d) => `${d.label}: ${(d.confidence * 100).toFixed(1)}%`)
                        .join(', ')}
                  <small>{mission.evidence.confidence_domain}</small>
                  <small>
                    Captured {new Date(mission.evidence.captured_at_ms).toLocaleTimeString()} ·{' '}
                    {mission.evidence.model_id}
                  </small>
                </figcaption>
              </figure>
            )}
            {mission.status === 'recovery_required' && <RecoveryReview mission={mission} />}
            {mission.status_detail !== null && (
              <p className="mission-detail">{mission.status_detail}</p>
            )}
          </article>
        ))}
        {missions.length === 0 && <p className="empty-state">No missions have been authorized.</p>}
      </div>
    </section>
  );
}

function RecoveryReview({ mission }: { readonly mission: Mission }) {
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const approve = useApproveProposal();
  async function review(): Promise<void> {
    setBusy(true);
    setError('');
    approve.reset();
    try {
      setProposal(await apiClient.proposeRecovery(mission.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Recovery review failed.');
    } finally {
      setBusy(false);
    }
  }
  const expired = proposal !== null && Date.now() >= Date.parse(proposal.expires_at);
  return (
    <div className="review-box">
      <p>Execution is held. Check the rover’s position and surroundings before continuing.</p>
      {proposal && (
        <>
          <dl>
            <div>
              <dt>Recovery command</dt>
              <dd>
                <code>{JSON.stringify(proposal.input.command)}</code>
              </dd>
            </div>
            <div>
              <dt>Review expires</dt>
              <dd>{new Date(proposal.expires_at).toLocaleTimeString()}</dd>
            </div>
          </dl>
          <p className="muted">{proposal.input.rationale}</p>
          {expired && <p role="status">This review expired. Prepare a new review.</p>}
        </>
      )}
      <div className="actions">
        <button
          className="secondary"
          type="button"
          disabled={busy || approve.isPending}
          onClick={() => {
            void review();
          }}
        >
          {busy ? 'Preparing review…' : proposal ? 'Refresh recovery review' : 'Review recovery'}
        </button>
        {proposal && (
          <button
            type="button"
            disabled={busy || approve.isPending || expired}
            onClick={() => approve.mutate(proposal)}
          >
            {approve.isPending ? 'Authorizing…' : 'Approve recovery'}
          </button>
        )}
      </div>
      {(error || approve.error) && (
        <p className="notice error" role="alert">
          {error || approve.error?.message}
        </p>
      )}
    </div>
  );
}
