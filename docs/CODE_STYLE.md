# Coding Standards

## Rust

- Domain entities own invariants.
- Application services orchestrate; they know no HTTP, SQL, NATS, or ROS.
- Infrastructure adapters implement ports.
- Prefer newtypes for security-sensitive identifiers and bounded values.
- Prefer enums over strings for closed vocabularies.
- Inject time, storage, signing, and transport through ports.
- Use structured tracing fields.
- Public interfaces require rustdoc.
- `unsafe` is forbidden in trusted Rust crates.

## React and TypeScript

- Strict TypeScript with no unchecked indexed access.
- Runtime validation at network boundaries.
- TanStack Query owns server state.
- XState is reserved for workflows with meaningful legal transitions.
- Local React state owns transient view state.
- Feature folders own components, tests, and state machines.
- No persistent browser secrets.
- Lazy-load heavy visualization code.
- Use native accessible controls before custom widgets.
- Avoid global state libraries until measured complexity requires one.

## C++

- C++20
- RAII and smart pointers
- no raw owning pointers
- warnings as errors
- lifecycle nodes for safety-sensitive gateways
- no internet-facing endpoints
- no command execution before local verification

## Python

- AI, research, and simulator tooling only
- strict Pydantic schemas at boundaries
- type hints on public functions
- no body credentials or signing keys
- no actuator publisher in AI services
