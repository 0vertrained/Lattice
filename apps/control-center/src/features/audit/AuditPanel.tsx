import type { AuditRecord } from '../../core/api/schemas';
import { StatusChip } from '../status';
import './ledger.css';

interface AuditPanelProps {
  readonly records: readonly AuditRecord[];
  /** How many records the section asked for; the log holds more once it fills. */
  readonly page: number;
  readonly loading: boolean;
  readonly failure: Error | null;
}

export interface LedgerRow {
  readonly record: AuditRecord;
  /** The core's recheck of this record's hash and link; undefined from an older core. */
  readonly verified: boolean | undefined;
  /** Whether this record's previous hash is the hash of the row below it, when that row is shown. */
  readonly linkedBelow: boolean | undefined;
}

/** Newest first, each row knowing whether it links to the one below it. */
export function ledgerRows(records: readonly AuditRecord[]): LedgerRow[] {
  const newest = [...records].reverse();
  return newest.map((record, index) => {
    const below = newest[index + 1];
    return {
      record,
      verified: record.verified,
      linkedBelow:
        below?.record_hash === undefined || record.previous_hash === undefined
          ? undefined
          : record.previous_hash === below.record_hash,
    };
  });
}

const short = (hash: string) => hash.slice(0, 8);

function actorLabel(record: AuditRecord): string {
  if ('operator' in record.actor) return record.actor.operator;
  if ('service' in record.actor) return record.actor.service;
  return record.actor.body;
}

function actorKind(record: AuditRecord): string {
  if ('operator' in record.actor) return 'Operator';
  if ('service' in record.actor) return 'Service';
  return 'Body';
}

/**
 * The audit log as a ledger: event names, object ids and hashes in B612 Mono, and the hash chain
 * drawn down the margin. Each record's hash follows from the one before it, so an edited or
 * removed record breaks the line. The core rechecks every link it returns.
 */
export function AuditPanel({ records, page, loading, failure }: AuditPanelProps) {
  const rows = ledgerRows(records);
  const chained = rows.filter((row) => row.verified !== undefined);
  const failed = chained.filter((row) => row.verified === false).length;
  return (
    <section className="plate ledger-plate" aria-labelledby="audit-title">
      <header className="plate-head">
        <div>
          <h2 id="audit-title">Audit ledger</h2>
          <p className="note">
            {records.length >= page
              ? `The latest ${page} records, newest first`
              : 'Every record, newest first'}
          </p>
        </div>
        {chained.length > 0 && (
          <StatusChip
            status={failed ? 'failed' : 'succeeded'}
            label={failed ? `${failed} not verified` : 'Chain verified'}
          />
        )}
      </header>
      <p className="plate-intro">
        Each record carries the SHA-256 of the record before it, so changing or removing one breaks
        every link after it. The core recomputed each hash below from the stored record and the one
        before it.
      </p>
      {failure && (
        <p className="plate-intro notice error" role="alert">
          {failure.message}
        </p>
      )}
      {loading && <p className="plate-intro empty-state">Loading the audit ledger…</p>}
      {!loading && rows.length === 0 && !failure && (
        <p className="plate-intro empty-state">No audited decisions yet.</p>
      )}
      {rows.length > 0 && (
        <ol className="ledger" reversed>
          {rows.map(({ record, verified, linkedBelow }) => (
            <li
              key={
                record.record_hash ??
                `${record.occurred_at}:${record.object_id}:${record.event_type}`
              }
              className="ledger-row"
              data-verified={verified === undefined ? undefined : String(verified)}
              data-link={linkedBelow === undefined ? undefined : String(linkedBelow)}
              data-first={record.previous_hash === null ? '' : undefined}
            >
              <span className="ledger-chain" aria-hidden="true" />
              <div className="ledger-hash">
                {record.record_hash ? (
                  <>
                    <code title={record.record_hash}>{short(record.record_hash)}</code>
                    <small>
                      {record.previous_hash ? (
                        <>
                          after{' '}
                          <code title={record.previous_hash}>{short(record.previous_hash)}</code>
                        </>
                      ) : (
                        'first record'
                      )}
                    </small>
                  </>
                ) : (
                  <small>No hash returned</small>
                )}
              </div>
              <div className="ledger-entry">
                <span className="ledger-event">{record.event_type}</span>
                <small>
                  <code>{record.object_id}</code>, by {actorKind(record).toLowerCase()}{' '}
                  {actorLabel(record)}
                </small>
                {verified === false && (
                  <p className="ledger-broken">
                    This record does not match its stored hash, or its link to the record before it
                    is broken.
                  </p>
                )}
              </div>
              <div className="ledger-when">
                <time dateTime={record.occurred_at}>
                  {new Date(record.occurred_at).toLocaleTimeString()}
                </time>
                {record.position !== undefined && (
                  <small className="figures">Record {record.position}</small>
                )}
              </div>
              <span className="visually-hidden">
                {verified === undefined
                  ? 'This core did not return a hash check.'
                  : verified
                    ? 'Hash and link verified by the core.'
                    : 'Not verified.'}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
