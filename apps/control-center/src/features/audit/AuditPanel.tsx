import type { AuditRecord } from '../../core/api/schemas';

interface AuditPanelProps {
  readonly records: readonly AuditRecord[];
}

function actorLabel(record: AuditRecord): string {
  if ('operator' in record.actor) return record.actor.operator;
  if ('service' in record.actor) return record.actor.service;
  return record.actor.body;
}

export function AuditPanel({ records }: AuditPanelProps) {
  return (
    <section className="panel" aria-labelledby="audit-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Decision provenance</p>
          <h2 id="audit-title">Audit trail</h2>
        </div>
        <span>Latest {Math.min(records.length, 8)}</span>
      </div>
      <div className="audit-list">
        {records
          .slice()
          .reverse()
          .slice(0, 8)
          .map((record) => (
            <article key={`${record.occurred_at}:${record.object_id}:${record.event_type}`}>
              <div>
                <strong>{record.event_type}</strong>
                <small>{actorLabel(record)}</small>
              </div>
              <time dateTime={record.occurred_at}>
                {new Date(record.occurred_at).toLocaleTimeString()}
              </time>
            </article>
          ))}
        {records.length === 0 && <p className="empty-state">No audited decisions yet.</p>}
      </div>
    </section>
  );
}
