use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::{BodyId, CommandId, DomainError, MissionId, SkillCommand};

/// Mission lifecycle state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MissionStatus {
    /// Waiting for an eligible body.
    Queued,
    /// A signed command is assigned to a body.
    Assigned,
    /// Body acknowledged execution.
    Running,
    /// Completed successfully.
    Succeeded,
    /// Completed unsuccessfully.
    Failed,
    /// Cancelled by an authorized actor.
    Cancelled,
    /// Lost its body and may be reassigned.
    Interrupted,
}

/// Durable user objective executed through a typed skill.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Mission {
    /// Stable mission identity.
    pub id: MissionId,
    /// Operator-facing title.
    pub title: String,
    /// Typed execution request.
    pub command: SkillCommand,
    /// Lifecycle state.
    pub status: MissionStatus,
    /// Currently assigned body.
    pub assigned_body_id: Option<BodyId>,
    /// Only command currently authorized to update this mission.
    pub active_command_id: Option<CommandId>,
    /// Best-effort operator progress.
    pub progress_pct: u8,
    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
    /// Last state change.
    pub updated_at: DateTime<Utc>,
    /// Operator-safe status detail.
    pub status_detail: Option<String>,
    /// Validated inspection result image and detections.
    #[serde(default)]
    pub evidence: Option<crate::InspectionEvidence>,
}

impl Mission {
    /// Creates a validated queued mission.
    pub fn new(
        id: MissionId,
        title: impl Into<String>,
        command: SkillCommand,
        now: DateTime<Utc>,
    ) -> Result<Self, DomainError> {
        let title = title.into();
        let trimmed = title.trim();
        if !(3..=120).contains(&trimmed.len()) || trimmed.chars().any(char::is_control) {
            return Err(DomainError::InvalidCommand(
                "mission title must contain 3 to 120 printable characters".to_owned(),
            ));
        }
        command.validate()?;

        Ok(Self {
            id,
            title: trimmed.to_owned(),
            command,
            status: MissionStatus::Queued,
            assigned_body_id: None,
            active_command_id: None,
            progress_pct: 0,
            created_at: now,
            updated_at: now,
            status_detail: None,
            evidence: None,
        })
    }

    /// Assigns or reassigns a mission and binds its active command.
    pub fn assign(
        &mut self,
        body_id: BodyId,
        command_id: CommandId,
        now: DateTime<Utc>,
    ) -> Result<(), DomainError> {
        if !matches!(
            self.status,
            MissionStatus::Queued | MissionStatus::Interrupted
        ) {
            return Err(invalid_transition(self.status, MissionStatus::Assigned));
        }
        self.assigned_body_id = Some(body_id);
        self.active_command_id = Some(command_id);
        self.status = MissionStatus::Assigned;
        self.updated_at = now;
        self.status_detail = None;
        Ok(())
    }

    /// Marks the assigned command as executing.
    pub fn mark_running(
        &mut self,
        command_id: &CommandId,
        progress_pct: u8,
        now: DateTime<Utc>,
    ) -> Result<(), DomainError> {
        self.validate_active_command(command_id)?;
        if !matches!(
            self.status,
            MissionStatus::Assigned | MissionStatus::Running
        ) {
            return Err(invalid_transition(self.status, MissionStatus::Running));
        }
        if progress_pct > 100 {
            return Err(DomainError::OutOfRange {
                field: "progress_pct",
                minimum: "0".to_owned(),
                maximum: "100".to_owned(),
            });
        }
        self.status = MissionStatus::Running;
        self.progress_pct = progress_pct;
        self.updated_at = now;
        Ok(())
    }

    /// Completes the active command successfully.
    pub fn mark_succeeded(
        &mut self,
        command_id: &CommandId,
        now: DateTime<Utc>,
    ) -> Result<(), DomainError> {
        self.validate_active_command(command_id)?;
        if !matches!(
            self.status,
            MissionStatus::Assigned | MissionStatus::Running
        ) {
            return Err(invalid_transition(self.status, MissionStatus::Succeeded));
        }
        self.status = MissionStatus::Succeeded;
        self.progress_pct = 100;
        self.updated_at = now;
        self.status_detail = None;
        Ok(())
    }

    /// Completes the active command unsuccessfully.
    pub fn mark_failed(
        &mut self,
        command_id: &CommandId,
        detail: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<(), DomainError> {
        self.validate_active_command(command_id)?;
        if !matches!(
            self.status,
            MissionStatus::Assigned | MissionStatus::Running
        ) {
            return Err(invalid_transition(self.status, MissionStatus::Failed));
        }
        self.status = MissionStatus::Failed;
        self.updated_at = now;
        self.status_detail = Some(limit_detail(detail.into()));
        Ok(())
    }

    /// Marks work eligible for reassignment.
    pub fn interrupt(
        &mut self,
        detail: impl Into<String>,
        now: DateTime<Utc>,
    ) -> Result<(), DomainError> {
        if !matches!(
            self.status,
            MissionStatus::Assigned | MissionStatus::Running
        ) {
            return Err(invalid_transition(self.status, MissionStatus::Interrupted));
        }
        self.status = MissionStatus::Interrupted;
        self.assigned_body_id = None;
        self.active_command_id = None;
        self.updated_at = now;
        self.status_detail = Some(limit_detail(detail.into()));
        Ok(())
    }

    /// Returns an interrupted mission to the unassigned queue.
    pub fn queue_after_interruption(&mut self, now: DateTime<Utc>) -> Result<(), DomainError> {
        if self.status != MissionStatus::Interrupted {
            return Err(invalid_transition(self.status, MissionStatus::Queued));
        }
        self.status = MissionStatus::Queued;
        self.updated_at = now;
        Ok(())
    }

    fn validate_active_command(&self, command_id: &CommandId) -> Result<(), DomainError> {
        if self.active_command_id.as_ref() != Some(command_id) {
            return Err(DomainError::InvalidCommand(
                "result does not match the mission's active command".to_owned(),
            ));
        }
        Ok(())
    }
}

fn invalid_transition(from: MissionStatus, to: MissionStatus) -> DomainError {
    DomainError::InvalidMissionTransition {
        from: format!("{from:?}"),
        to: format!("{to:?}"),
    }
}

fn limit_detail(mut detail: String) -> String {
    detail = detail.chars().take(500).collect();
    detail
}

#[cfg(test)]
mod tests {
    use chrono::Utc;

    use super::Mission;
    use crate::{BodyId, CommandId, MissionId, SkillCommand};

    fn valid_mission() -> Mission {
        let result = Mission::new(
            MissionId::new("mission-test")
                .unwrap_or_else(|error| unreachable!("test mission id is valid: {error}")),
            "Inspect garage",
            SkillCommand::Inspect {
                location: "garage".to_owned(),
            },
            Utc::now(),
        );
        result.unwrap_or_else(|error| unreachable!("test mission is valid: {error}"))
    }

    #[test]
    fn completed_mission_cannot_run_again() {
        let now = Utc::now();
        let mut mission = valid_mission();
        let command_id = CommandId::new("command-test")
            .unwrap_or_else(|error| unreachable!("test command id is valid: {error}"));
        mission
            .assign(
                BodyId::new("rover-r1")
                    .unwrap_or_else(|error| unreachable!("test body id is valid: {error}")),
                command_id.clone(),
                now,
            )
            .unwrap_or_else(|error| unreachable!("assignment is valid: {error}"));
        mission
            .mark_succeeded(&command_id, now)
            .unwrap_or_else(|error| unreachable!("completion is valid: {error}"));

        assert!(mission.mark_running(&command_id, 50, now).is_err());
    }

    #[test]
    fn stale_command_cannot_update_reassigned_mission() {
        let now = Utc::now();
        let mut mission = valid_mission();
        let first = CommandId::new("command-first")
            .unwrap_or_else(|error| unreachable!("valid command id: {error}"));
        let second = CommandId::new("command-second")
            .unwrap_or_else(|error| unreachable!("valid command id: {error}"));
        mission
            .assign(
                BodyId::new("rover-r1")
                    .unwrap_or_else(|error| unreachable!("valid body id: {error}")),
                first.clone(),
                now,
            )
            .unwrap_or_else(|error| unreachable!("valid assignment: {error}"));
        mission
            .interrupt("body offline", now)
            .unwrap_or_else(|error| unreachable!("valid interruption: {error}"));
        mission
            .assign(
                BodyId::new("quad-q1")
                    .unwrap_or_else(|error| unreachable!("valid body id: {error}")),
                second,
                now,
            )
            .unwrap_or_else(|error| unreachable!("valid reassignment: {error}"));

        assert!(mission.mark_running(&first, 25, now).is_err());
    }
}
