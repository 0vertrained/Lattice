//! Revocable high-entropy body credentials. Raw bearer tokens never enter the database.
use crate::postgres::{PostgresUnit, failure};
use chrono::{DateTime, Utc};
use lattice_application::ApplicationError;
use lattice_domain::BodyId;
use serde::Serialize;

/// Public credential metadata returned to an administrator.
#[derive(Clone, Serialize)]
pub struct DeviceCredential {
    /// Stable identity used to revoke this credential.
    pub id: String,
    /// Only body this credential may act as.
    pub body_id: BodyId,
    /// Operator label.
    pub label: String,
    /// Provisioning timestamp.
    pub created_at: DateTime<Utc>,
    /// Expiration deadline.
    pub expires_at: DateTime<Utc>,
    /// Revocation timestamp, when revoked.
    pub revoked_at: Option<DateTime<Utc>>,
}
impl PostgresUnit {
    /// Stores a digest, never the token. Issuance shares the admin audit transaction.
    pub async fn issue_device(
        &self,
        device: &DeviceCredential,
        hash: &str,
    ) -> Result<(), ApplicationError> {
        self.client()
            .execute(
                "INSERT INTO device_credentials VALUES($1,$2,$3,$4,$5,$6,NULL)",
                &[
                    &device.id,
                    &device.body_id.as_str(),
                    &device.label,
                    &hash,
                    &device.created_at,
                    &device.expires_at,
                ],
            )
            .await
            .map_err(failure)?;
        Ok(())
    }
    /// Lists credential metadata without hashes or bearer secrets.
    pub async fn list_devices(&self) -> Result<Vec<DeviceCredential>, ApplicationError> {
        self.client().query("SELECT credential_id,body_id,label,created_at,expires_at,revoked_at FROM device_credentials ORDER BY created_at DESC",&[]).await.map_err(failure)?.iter().map(|r| Ok(DeviceCredential {id:r.get(0),body_id:BodyId::new(r.get::<_,String>(1))?,label:r.get(2),created_at:r.get(3),expires_at:r.get(4),revoked_at:r.get(5)})).collect()
    }
    /// Resolves an active credential. Call again within each mutation transaction.
    pub async fn authenticate_device(
        &self,
        hash: &str,
    ) -> Result<Option<(String, BodyId)>, ApplicationError> {
        self.client().query_opt("SELECT credential_id,body_id FROM device_credentials WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()",&[&hash]).await.map_err(failure)?.map(|r| Ok((r.get(0),BodyId::new(r.get::<_,String>(1))?))).transpose()
    }
    /// Revokes one credential; returns false for an unknown id.
    pub async fn revoke_device(&self, id: &str) -> Result<bool, ApplicationError> {
        Ok(self.client().execute("UPDATE device_credentials SET revoked_at=COALESCE(revoked_at,now()) WHERE credential_id=$1",&[&id]).await.map_err(failure)?==1)
    }
}
