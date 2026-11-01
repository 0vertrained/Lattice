use chrono::{DateTime, Utc};
use lattice_application::Clock;

/// System UTC clock.
#[derive(Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}
