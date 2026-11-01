# ADR 0004: React control center

Status: Accepted

## Decision

Use React with strict TypeScript and Vite for Lattice Control Center.

- TanStack Query manages server state.
- XState manages workflows with legal state transitions.
- React Three Fiber powers the digital twin.
- Heavy 3D code is lazy-loaded.
- Foxglove remains the raw robotics diagnostics surface.
- Tauri may package the application later.

## Alternatives considered

### Angular

Strong for standardized enterprise workflows, but offers no decisive advantage for
Lattice's 3D and robotics-oriented UI and would add a framework-specific architecture
that the team does not otherwise require.

### Next.js

Server rendering, server components, SEO, and frontend-owned server actions are not
needed for a private local control center. A static Vite application reduces runtime
and attack surface.

### Redux

Not adopted. Server state belongs in TanStack Query, workflow state in XState, and
transient view state in React. Redux may be reconsidered only after measured need.
