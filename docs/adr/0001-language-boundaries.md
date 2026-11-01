# ADR 0001: Language boundaries

Status: Accepted

## Decision

- Rust owns the trusted control plane.
- C++ owns ROS 2, vendor SDK, and latency-sensitive robotics integration.
- Python owns AI inference, research, and simulator scripting only.
- React/TypeScript owns the operator product.

## Rationale

No one language is best across the system. Rust provides memory-safe native
services; C++ has the strongest robotics ecosystem; Python has the dominant ML
ecosystem; React has the strongest fit for interactive product workflows and 3D UI.

## Consequences

Cross-language communication uses versioned typed contracts. Python cannot directly
command actuators. C++ gateways remain isolated from public networks.
