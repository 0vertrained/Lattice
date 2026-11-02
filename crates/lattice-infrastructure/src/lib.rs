#![doc = "Concrete Lattice adapters for memory, local PostgreSQL, signing and time."]

mod crypto;
mod devices;
pub use devices::DeviceCredential;
mod handoffs;
mod memory;
mod navigation;
mod observations;
mod postgres;
pub use postgres::{PostgresPlatform, PostgresUnit};
mod time;

pub use crypto::Ed25519CommandSigner;
pub use memory::InMemoryPlatform;
pub use time::SystemClock;
