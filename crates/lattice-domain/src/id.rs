use std::fmt::{Display, Formatter};

use serde::{Deserialize, Serialize};

use crate::DomainError;

fn validate_identifier(kind: &'static str, value: &str) -> Result<(), DomainError> {
    if !(3..=64).contains(&value.len()) {
        return Err(DomainError::InvalidIdentifier {
            kind,
            reason: "length must be between 3 and 64 bytes".to_owned(),
        });
    }

    if !value
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(DomainError::InvalidIdentifier {
            kind,
            reason: "only ASCII letters, numbers, '-', '_', '.', and ':' are allowed".to_owned(),
        });
    }

    Ok(())
}

macro_rules! identifier {
    ($name:ident, $kind:literal) => {
        #[doc = concat!("Stable ", $kind, ".")]
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(String);

        impl $name {
            #[doc = concat!("Creates and validates a ", $kind, ".")]
            pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
                let value = value.into();
                validate_identifier($kind, &value)?;
                Ok(Self(value))
            }

            /// Borrows the identifier as text.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl Display for $name {
            fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(&self.0)
            }
        }
    };
}

identifier!(BodyId, "body identifier");
identifier!(MissionId, "mission identifier");
identifier!(CommandId, "command identifier");

#[cfg(test)]
mod tests {
    use super::BodyId;

    #[test]
    fn rejects_path_traversal_characters() {
        assert!(BodyId::new("../../robot").is_err());
    }

    #[test]
    fn accepts_namespaced_identifier() {
        let result = BodyId::new("lab:rover-r1");
        assert!(result.is_ok());
    }
}
