import type { Body, Mission } from '../../core/api/schemas';

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
              <span className={`status-pill ${mission.status}`}>{mission.status}</span>
            </div>
            <div className="command-summary">
              <code>{mission.command.type}</code>
              <span>{mission.active_command_id ?? 'No active command'}</span>
            </div>
            <progress value={mission.progress_pct} max={100} />
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
