//! The audit log as a ledger: each record with its hash-chain link, rechecked on read.
use lattice_domain::{AuditRecord, DomainError, chain_hash};
use serde::Serialize;

use crate::{ApplicationError, LatticeService, StoredAuditRecord};

/// At most this many records are returned when a caller asks for the latest ones.
pub const MAX_AUDIT_PAGE: usize = 500;

/// One audit record with its place in the hash chain.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AuditEntry {
    /// Position in the log, counting from 1.
    pub position: u64,
    /// The record itself, at the top level so existing readers keep working.
    #[serde(flatten)]
    pub record: AuditRecord,
    /// Stored hash of the record before this one, as hex; none for the first record.
    pub previous_hash: Option<String>,
    /// Stored hash of this record, as hex.
    pub record_hash: String,
    /// The core recomputed this record's hash from the stored record and previous hash and
    /// found the stored value, and the previous hash is the stored hash of the record before.
    pub verified: bool,
}

/// Rechecks every link in `rows` and returns entries for all but the first `context` rows,
/// which are read only so the oldest returned record's link can be checked too.
pub fn verify_chain(rows: &[StoredAuditRecord], context: usize) -> Vec<AuditEntry> {
    rows.iter()
        .enumerate()
        .skip(context)
        .map(|(index, row)| {
            let recomputed = chain_hash(row.previous_hash.as_deref(), &row.record)
                .is_ok_and(|hash| hash == row.record_hash);
            let linked = match index.checked_sub(1).and_then(|before| rows.get(before)) {
                Some(before) => row.previous_hash.as_ref() == Some(&before.record_hash),
                // Nothing was read before this row, so it must be the first record of all.
                None => row.position == 1 && row.previous_hash.is_none(),
            };
            AuditEntry {
                position: row.position,
                record: row.record.clone(),
                previous_hash: row.previous_hash.as_deref().map(hex),
                record_hash: hex(&row.record_hash),
                verified: recomputed && linked,
            }
        })
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

impl LatticeService {
    /// The latest `latest` audit records, or all of them, oldest first, each with its link
    /// rechecked.
    pub async fn audit_ledger(
        &self,
        latest: Option<usize>,
    ) -> Result<Vec<AuditEntry>, ApplicationError> {
        if latest.is_some_and(|count| !(1..=MAX_AUDIT_PAGE).contains(&count)) {
            return Err(DomainError::OutOfRange {
                field: "limit",
                minimum: "1".into(),
                maximum: MAX_AUDIT_PAGE.to_string(),
            }
            .into());
        }
        // One more record than asked for, so the oldest returned link can be checked.
        let rows = self.audit.chain(latest.map(|count| count + 1)).await?;
        let context = latest.map_or(0, |count| rows.len().saturating_sub(count));
        Ok(verify_chain(&rows, context))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use chrono::{TimeZone, Utc};
    use lattice_domain::AuditActor;

    fn log(count: usize) -> Vec<StoredAuditRecord> {
        let mut rows: Vec<StoredAuditRecord> = Vec::new();
        for index in 0..count {
            let record = AuditRecord {
                occurred_at: Utc.timestamp_opt(1_800_000_000 + index as i64, 0).unwrap(),
                actor: AuditActor::Operator("operator-a".into()),
                event_type: "round.approved".into(),
                object_id: format!("round-{index}"),
                metadata: serde_json::json!({ "steps": index }),
            };
            let previous_hash = rows.last().map(|row| row.record_hash.clone());
            let record_hash = chain_hash(previous_hash.as_deref(), &record).unwrap();
            rows.push(StoredAuditRecord {
                position: index as u64 + 1,
                record,
                previous_hash,
                record_hash,
            });
        }
        rows
    }

    #[test]
    fn an_intact_log_verifies_from_its_first_record() {
        let entries = verify_chain(&log(4), 0);
        assert_eq!(entries.len(), 4);
        assert!(entries.iter().all(|entry| entry.verified));
        assert_eq!(entries[0].previous_hash, None);
        assert_eq!(
            entries[1].previous_hash.as_ref(),
            Some(&entries[0].record_hash)
        );
        assert_eq!(entries[0].record_hash.len(), 64);
    }

    #[test]
    fn a_window_checks_its_oldest_link_against_the_record_before_it() {
        let rows = log(5);
        let window = verify_chain(&rows[2..], 1);
        assert_eq!(
            window
                .iter()
                .map(|entry| entry.position)
                .collect::<Vec<_>>(),
            [4, 5]
        );
        assert!(window.iter().all(|entry| entry.verified));
        // Without the record before it, a later record cannot be shown as linked.
        assert!(!verify_chain(&rows[3..], 0)[0].verified);
    }

    #[test]
    fn an_edited_record_or_a_broken_link_is_not_verified() {
        let mut rows = log(4);
        rows[1].record.object_id = "round-edited".into();
        let entries = verify_chain(&rows, 0);
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.verified)
                .collect::<Vec<_>>(),
            [true, false, true, true],
            "the edited record no longer matches its stored hash"
        );
        let mut rows = log(4);
        rows[2].previous_hash = Some(rows[0].record_hash.clone());
        let entries = verify_chain(&rows, 0);
        assert!(!entries[2].verified);
    }

    #[test]
    fn the_api_record_fields_stay_at_the_top_level() {
        let entry = verify_chain(&log(1), 0).remove(0);
        let json = serde_json::to_value(&entry).unwrap();
        for field in [
            "occurred_at",
            "actor",
            "event_type",
            "object_id",
            "metadata",
            "position",
            "previous_hash",
            "record_hash",
            "verified",
        ] {
            assert!(json.get(field).is_some(), "{field}");
        }
    }
}
