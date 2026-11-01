# ADR 0003: Typed command vocabulary

Status: Accepted

## Decision

Executable commands are a closed, versioned enum/Protobuf union. Arbitrary JSON,
shell commands, generated source code, and direct actuator values are forbidden in
the trusted command path.

## Rationale

Typed skills are reviewable, bounded, testable, auditable, and portable across
bodies. They prevent a probabilistic planner from inventing an unsafe interface.

## Consequence

Adding a skill requires domain code, local safety policy, adapter implementation,
simulator tests, operator UX, and protocol review.
