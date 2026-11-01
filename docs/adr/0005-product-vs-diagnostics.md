# ADR 0005: Separate product UI from robotics diagnostics

Status: Accepted

## Decision

Lattice Control Center displays missions, bodies, policies, approvals, semantic
world state, and normalized telemetry. Foxglove/MCAP will display raw ROS topics,
TF, point clouds, camera streams, plots, and engineering replay.

## Rationale

Rebuilding mature robotics diagnostics in the product UI would consume time,
expand attack surface, and couple operator workflows to ROS internals.
