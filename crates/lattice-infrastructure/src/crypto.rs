use async_trait::async_trait;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use ed25519_dalek::{Signer, SigningKey};
use lattice_application::{ApplicationError, CommandSigner};
use lattice_domain::{CommandEnvelope, SignedCommand, VerificationKey};
use rand_core::OsRng;

/// Ed25519 command signer.
///
/// Physical deployments must load the private key from a hardware-backed key
/// store. This development implementation generates an ephemeral key at startup.
pub struct Ed25519CommandSigner {
    key_id: String,
    signing_key: SigningKey,
}

impl Ed25519CommandSigner {
    /// Generates a process-local development key.
    pub fn generate_ephemeral(key_id: impl Into<String>) -> Self {
        Self {
            key_id: key_id.into(),
            signing_key: SigningKey::generate(&mut OsRng),
        }
    }
}

#[async_trait]
impl CommandSigner for Ed25519CommandSigner {
    async fn sign(&self, envelope: CommandEnvelope) -> Result<SignedCommand, ApplicationError> {
        let bytes = envelope
            .signing_bytes()
            .map_err(|_| ApplicationError::Security)?;
        let signature = self.signing_key.sign(&bytes);

        Ok(SignedCommand {
            envelope,
            signature_base64: STANDARD.encode(signature.to_bytes()),
            key_id: self.key_id.clone(),
        })
    }

    async fn verification_key(&self) -> Result<VerificationKey, ApplicationError> {
        Ok(VerificationKey {
            key_id: self.key_id.clone(),
            public_key_base64: STANDARD.encode(self.signing_key.verifying_key().to_bytes()),
            algorithm: "Ed25519".to_owned(),
        })
    }
}
