# Contributing

## Start here

1. Read `ARCHITECTURE.md`, `SECURITY.md`, `THREAT_MODEL.md`, and relevant ADRs.
2. Describe the invariant, capability, or operator workflow being changed.
3. Keep the change in the narrowest layer possible.
4. Add success, rejection, and recovery tests.
5. Update contracts and documentation in the same pull request.

## Review checklist

- Is behavior represented by a typed domain concept?
- Can invalid state be rejected before I/O?
- Does this create or widen a trust boundary?
- Can a model or browser bypass the command broker?
- Are logs free of secrets and unnecessary personal data?
- Are external systems accessed through ports?
- Are retries idempotent?
- Is failure safe?
- Can a new engineer understand the code without tribal knowledge?
- Are public interfaces documented?
- Are tests deterministic?

## Pull request size

Prefer small vertical changes. A review should generally cover one invariant,
one adapter, or one operator workflow. Avoid mixing broad refactoring with behavior
changes.

## Error handling

- Do not use `unwrap`, `expect`, or `panic` in production Rust paths.
- Domain errors may include actionable validation detail.
- Transport errors must not reveal secrets or infrastructure internals.
- Log internal failures once at the boundary with request and trace IDs.

## Dependencies

A new dependency requires:

- a clear reason
- active maintenance
- acceptable license
- bounded features
- security review
- no wildcard version
