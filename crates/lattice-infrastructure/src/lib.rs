#![doc = "Concrete Lattice adapters. Production database and event-bus adapters land here."]

mod crypto;
mod memory;
mod time;

pub use crypto::Ed25519CommandSigner;
pub use memory::InMemoryPlatform;
pub use time::SystemClock;
