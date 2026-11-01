import { useMachine } from '@xstate/react';
import { useMemo, useState } from 'react';
import { useCreateMission } from '../../core/api/queries';
import type { CreateMissionRequest, SkillCommand } from '../../core/api/schemas';
import { missionApprovalMachine } from './missionApprovalMachine';

type SkillChoice = 'inspect' | 'navigate';

interface MissionComposerProps {
  readonly onCreated: () => void;
}

export function MissionComposer({ onCreated }: MissionComposerProps) {
  const [snapshot, send] = useMachine(missionApprovalMachine);
  const createMission = useCreateMission();
  const [title, setTitle] = useState('Inspect the garage');
  const [location, setLocation] = useState('garage');
  const [skill, setSkill] = useState<SkillChoice>('inspect');

  const command = useMemo<SkillCommand>(
    () =>
      skill === 'navigate'
        ? { type: 'navigate', destination: location.trim(), max_speed_mps: 0.8 }
        : { type: 'inspect', location: location.trim() },
    [location, skill],
  );

  const request = useMemo<CreateMissionRequest>(
    () => ({ title: title.trim(), command }),
    [command, title],
  );

  const canReview = request.title.length >= 3 && location.trim().length > 0;

  function authorize(): void {
    send({ type: 'AUTHORIZE' });
    createMission.mutate(request, {
      onSuccess: () => {
        send({ type: 'SUCCESS' });
        onCreated();
      },
      onError: () => send({ type: 'FAILURE' }),
    });
  }

  function reset(): void {
    send({ type: 'RESET' });
    createMission.reset();
  }

  return (
    <section className="panel mission-composer" aria-labelledby="mission-composer-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Typed skill request</p>
          <h2 id="mission-composer-title">Create mission</h2>
        </div>
        <span className="workflow-state">{String(snapshot.value)}</span>
      </div>

      {snapshot.matches('editing') && (
        <div className="form-grid">
          <label>
            Mission title
            <input
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            Skill
            <select value={skill} onChange={(event) => setSkill(event.target.value as SkillChoice)}>
              <option value="inspect">Inspect</option>
              <option value="navigate">Navigate</option>
            </select>
          </label>
          <label className="full-width">
            Semantic location
            <input
              value={location}
              maxLength={100}
              onChange={(event) => setLocation(event.target.value)}
            />
          </label>
          <div className="actions full-width">
            <button type="button" disabled={!canReview} onClick={() => send({ type: 'REVIEW' })}>
              Review mission
            </button>
          </div>
        </div>
      )}

      {snapshot.matches('reviewing') && (
        <div className="review-box">
          <dl>
            <div>
              <dt>Mission</dt>
              <dd>{request.title}</dd>
            </div>
            <div>
              <dt>Typed command</dt>
              <dd>
                <code>{JSON.stringify(request.command)}</code>
              </dd>
            </div>
            <div>
              <dt>Security path</dt>
              <dd>Policy validation → capability match → signed expiring command</dd>
            </div>
          </dl>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => send({ type: 'EDIT' })}>
              Edit
            </button>
            <button type="button" onClick={authorize}>
              Authorize mission
            </button>
          </div>
        </div>
      )}

      {snapshot.matches('submitting') && <p className="notice">Authorizing typed command…</p>}

      {snapshot.matches('succeeded') && (
        <div className="notice success" role="status">
          <p>Mission authorized. Lattice selected the best eligible body.</p>
          <button type="button" onClick={reset}>
            Create another
          </button>
        </div>
      )}

      {snapshot.matches('failed') && (
        <div className="notice error" role="alert">
          <p>{createMission.error?.message ?? 'Lattice Core rejected the mission.'}</p>
          <div className="actions">
            <button type="button" className="secondary" onClick={() => send({ type: 'EDIT' })}>
              Edit
            </button>
            <button type="button" onClick={() => send({ type: 'RETRY' })}>
              Review again
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
