import { useMachine } from '@xstate/react';
import { useState } from 'react';
import { apiClient } from '../../core/api/apiClient';
import { useApproveProposal } from '../../core/api/queries';
import type { Proposal, SkillCommand } from '../../core/api/schemas';
import { missionApprovalMachine } from './missionApprovalMachine';

export function MissionComposer() {
  const approve = useApproveProposal();
  const [snapshot, send] = useMachine(missionApprovalMachine);
  const [mode, setMode] = useState<'language' | 'manual'>('language');
  const [intent, setIntent] = useState('Inspect the safety marker at the inspection bay');
  const [location, setLocation] = useState('inspection_bay');
  const [skill, setSkill] = useState<'navigate' | 'inspect'>('inspect');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const complete = snapshot.matches('succeeded');

  async function review(): Promise<void> {
    setBusy(true);
    setError('');
    try {
      const command: SkillCommand =
        skill === 'navigate'
          ? { type: 'navigate', destination: location, max_speed_mps: 0.3 }
          : { type: 'inspect', location };
      setProposal(
        mode === 'language'
          ? await apiClient.plan(intent)
          : await apiClient.propose({ title: intent, command }),
      );
      send({ type: 'REVIEW' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Proposal failed.');
    } finally {
      setBusy(false);
    }
  }

  function reset(): void {
    setProposal(null);
    setError('');
    send({ type: snapshot.matches('succeeded') ? 'RESET' : 'EDIT' });
    approve.reset();
  }

  return (
    <section className="panel mission-composer" aria-labelledby="mission-composer-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Language → review → approved mission</p>
          <h2 id="mission-composer-title">Create mission</h2>
        </div>
      </div>
      {proposal === null && (
        <div className="form-grid">
          <label>
            Request method
            <select
              disabled={busy}
              value={mode}
              onChange={(e) => setMode(e.target.value as 'language' | 'manual')}
            >
              <option value="language">Trained intent classifier</option>
              <option value="manual">Typed command</option>
            </select>
          </label>
          <label className="full-width">
            What should the rover do?
            <textarea
              disabled={busy}
              value={intent}
              maxLength={500}
              rows={3}
              onChange={(e) => setIntent(e.target.value)}
            />
          </label>
          {mode === 'manual' && (
            <>
              <label>
                Skill
                <select
                  value={skill}
                  disabled={busy}
                  onChange={(e) => setSkill(e.target.value as 'navigate' | 'inspect')}
                >
                  <option value="navigate">Navigate</option>
                  <option value="inspect">Inspect safety marker</option>
                </select>
              </label>
              <label>
                Destination
                <select
                  value={location}
                  disabled={busy}
                  onChange={(e) => setLocation(e.target.value)}
                >
                  <option value="loading_dock">Loading dock</option>
                  <option value="charging_station">Charging station</option>
                  <option value="inspection_bay">Inspection bay</option>
                </select>
              </label>
            </>
          )}
          <p className="muted full-width">
            One destination per request: loading dock, charging station, or inspection bay.
            Inspection looks for the octagonal safety marker. The model may ask you to clarify.
          </p>
          <div className="actions full-width">
            <button
              type="button"
              disabled={busy || intent.trim().length < 3}
              onClick={() => {
                void review();
              }}
            >
              {busy ? 'Preparing proposal…' : 'Prepare for review'}
            </button>
          </div>
        </div>
      )}
      {proposal !== null && !complete && (
        <div className="review-box">
          <dl>
            <div>
              <dt>Original request</dt>
              <dd>{proposal.input.user_intent}</dd>
            </div>
            <div>
              <dt>Decision</dt>
              <dd>
                {proposal.input.decision}: {proposal.input.rationale}
              </dd>
            </div>
            <div>
              <dt>Proposed command</dt>
              <dd>
                <code>{JSON.stringify(proposal.input.command)}</code>
              </dd>
            </div>
            <div>
              <dt>Model</dt>
              <dd>{proposal.input.model_id}</dd>
            </div>
            <div>
              <dt>Classifier score</dt>
              <dd>{(proposal.input.confidence * 100).toFixed(1)}% — not a safety guarantee</dd>
            </div>
            <div>
              <dt>Review expires</dt>
              <dd>{new Date(proposal.expires_at).toLocaleTimeString()}</dd>
            </div>
          </dl>
          <p className="muted">
            Approval applies to this exact command. Editing requires a new proposal.
          </p>
          <div className="actions">
            <button
              className="secondary"
              type="button"
              disabled={approve.isPending}
              onClick={reset}
            >
              Edit request
            </button>
            {proposal.input.decision === 'ready' && (
              <button
                type="button"
                disabled={approve.isPending}
                onClick={() => {
                  if (snapshot.matches('failed')) send({ type: 'RETRY' });
                  send({ type: 'AUTHORIZE' });
                  approve.mutate(proposal, {
                    onSuccess: () => send({ type: 'SUCCESS' }),
                    onError: () => send({ type: 'FAILURE' }),
                  });
                }}
              >
                {approve.isPending ? 'Authorizing…' : 'Approve and dispatch'}
              </button>
            )}
          </div>
        </div>
      )}
      {complete && (
        <div className="notice success" role="status">
          <p>Approved. Track execution and inspection evidence below.</p>
          <button type="button" onClick={reset}>
            Create another
          </button>
        </div>
      )}
      {(error || approve.error) && (
        <p className="notice error" role="alert">
          {error || approve.error?.message}
        </p>
      )}
      <button
        type="button"
        className="secondary"
        onClick={() => {
          void apiClient
            .exportTrace()
            .catch((cause: unknown) =>
              setError(cause instanceof Error ? cause.message : 'Trace export failed.'),
            );
        }}
      >
        Download session trace
      </button>
    </section>
  );
}
