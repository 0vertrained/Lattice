import type { Body } from '../../core/api/schemas';

interface FleetPanelProps {
  readonly bodies: readonly Body[];
  readonly loading: boolean;
}

export function FleetPanel({ bodies, loading }: FleetPanelProps) {
  return (
    <section className="panel" aria-labelledby="fleet-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Capability registry</p>
          <h2 id="fleet-title">Embodiments</h2>
        </div>
        <span>{bodies.length} registered</span>
      </div>

      {loading && <p className="muted">Loading fleet state…</p>}
      {!loading && bodies.length === 0 && (
        <p className="empty-state">Start a mock body or simulator adapter to register it here.</p>
      )}

      <div className="fleet-grid">
        {bodies.map((body) => (
          <article className="body-card" key={body.id}>
            <div className="card-title-row">
              <div>
                <strong>{body.display_name}</strong>
                <small>{body.kind}</small>
              </div>
              <span className={`status-pill ${body.status}`}>
                {body.status.replaceAll('_', ' ')}
              </span>
            </div>
            <p>{body.location}</p>
            <div className="capability-list">
              {body.capabilities.map((capability) => (
                <span key={capability}>{capability.replaceAll('_', ' ')}</span>
              ))}
            </div>
            <div className="battery-row">
              <progress value={body.battery} max={100} />
              <small>{body.battery}%</small>
            </div>
            <small>Adapter {body.adapter_version}</small>
          </article>
        ))}
      </div>
    </section>
  );
}
