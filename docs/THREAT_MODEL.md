# Threat Model

## Protected assets

- human and animal safety
- physical property
- body signing and device keys
- mission authorization
- maps, cameras, and evidence
- operator identity and private context
- audit integrity
- software update channel

## Trust boundaries

1. Browser to core API
2. AI gateway to core
3. Core to body agent
4. Body agent to ROS/vendor SDK
5. ROS/vendor SDK to embedded controller
6. External network to local deployment
7. Build pipeline to released artifact

## Priority threats

| Threat | Starter controls | Physical-deployment controls |
|---|---|---|
| Forged command | Ed25519 signature, typed payload | TPM-backed keys, mTLS, rotation |
| Replayed command | Per-body sequence and command ID | Durable sequence state |
| Delayed command | Signed expiry | Secure time and bounded skew |
| Wrong body executes | Signed target body ID | Certificate-bound identity |
| Stale result after handoff | Active command binding | Durable optimistic concurrency |
| Compromised model | Proposal-only process | Capability policy and approval |
| Browser credential theft | Memory-only dev key and CSP | OIDC and short sessions |
| ROS graph compromise | Process boundary | DDS security and network isolation |
| Network loss | No remote motor path | Local watchdog and stop |
| Malicious update | Pinned source dependencies | Signed OTA and rollback protection |
| Audit tampering | Append-only abstraction | Hash chain and remote copy |
| Sensor spoofing | Provenance metadata | Fusion and anomaly detection |
| Denial of service | size and concurrency limits | ACLs, rate limits, quotas |

## Explicit non-goals for this starter

- autonomous weapons
- covert surveillance
- unrestricted public-network control
- safety certification
- unattended high-energy machinery
