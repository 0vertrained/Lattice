import { useState } from 'react';

const blocks = [
  {
    id: 'operator',
    name: 'Operator',
    subtitle: 'Review the full objective',
    text: 'An operator signs in with OIDC and reviews every step and its failure policy. The approval identifies the exact plan digest. A viewer can inspect evidence without authorizing motion.',
    file: 'apps/control-center/src/features/missions/InspectionRound.tsx',
  },
  {
    id: 'core',
    name: 'Rust core',
    subtitle: 'Own identity and authorization',
    text: 'PostgreSQL commits approval, signed commands, sequences and audit records together. A changed core revision holds unfinished work and fences the previous writer. Model output has no execution authority.',
    file: 'crates/lattice-application/src/round.rs',
  },
  {
    id: 'agent',
    name: 'Robot agent',
    subtitle: 'Verify before dispatch',
    text: 'A credential is bound to one body. The Rust agent verifies the Ed25519 signature, body, expiry and persisted sequence. Revocation, lost connectivity or a changed core epoch stops the local motion lease.',
    file: 'robots/lattice-ros2-body/src/main.rs',
  },
  {
    id: 'ros',
    name: 'ROS 2 + Nav2',
    subtitle: 'Execute bounded movement',
    text: 'The C++ gateway forwards a verified goal to Nav2, tracks real map localization and enforces local speed and connection limits. A separate Gazebo deadman stops the motor when command updates disappear.',
    file: 'services/lattice-ros2-gateway/src/main.cpp',
  },
  {
    id: 'perception',
    name: 'Perception',
    subtitle: 'Return evidence with uncertainty',
    text: 'After arrival, the rover captures a fresh RGB frame. A locally trained classifier evaluates marker candidates. The mission retains the image, model identity, timestamp and hashes, including when no marker is detected.',
    file: 'services/lattice-ai-gateway/app/vision.py',
  },
] as const;
type BlockId = (typeof blocks)[number]['id'];

const ticks = (
  <svg className="ticks" viewBox="0 0 18 18" aria-hidden="true">
    <path d="M1 8l16-5M1 15l16-5" />
  </svg>
);

/**
 * Who may do what, as a schematic: authority flows down the chain, and each link that carries a
 * digest, signature or hash is marked with hash ticks. Choosing a block shows its links and its role.
 */
export function Schematic({
  digest,
  frame,
  source,
}: {
  /** The recorded round's plan digest. */
  readonly digest: string;
  /** SHA-256 of a recorded camera frame. */
  readonly frame: string | undefined;
  readonly source: string;
}) {
  const [selected, setSelected] = useState<BlockId>('core');
  const chosen = blocks.find((block) => block.id === selected) ?? blocks[1];
  const on = (ends: readonly BlockId[]) => (ends.includes(selected) ? '' : undefined);
  const block = (id: BlockId) => {
    const { name, subtitle } = blocks.find((item) => item.id === id) ?? blocks[0];
    return (
      <button
        type="button"
        className={id === 'perception' ? 'block branch-block' : 'block'}
        style={{ gridArea: id }}
        aria-pressed={selected === id}
        data-on={id === 'perception' ? on(['agent', 'perception']) : undefined}
        onClick={() => setSelected(id)}
      >
        {id === 'perception' && ticks}
        <strong>{name}</strong>
        <small>{subtitle}</small>
      </button>
    );
  };
  // Document order follows the chain, so it reads top to bottom; the grid places the side branch.
  return (
    <div className="schematic-layout">
      <fieldset className="plate schematic" aria-label="Lattice components and their links">
        {block('operator')}
        <p className="link" style={{ gridArea: 'approve' }} data-on={on(['operator', 'core'])}>
          {ticks}
          Approval names the plan digest <code>sha256 {digest.slice(0, 12)}…</code>
        </p>
        {block('core')}
        <p className="link" style={{ gridArea: 'command' }} data-on={on(['core', 'agent'])}>
          {ticks}
          Ed25519-signed command, bound to one body, with expiry and sequence
        </p>
        {block('agent')}
        <p className="link" style={{ gridArea: 'goal' }} data-on={on(['agent', 'ros'])}>
          Verified goal and motion lease, over a local socket
        </p>
        {block('ros')}
        {block('perception')}
        <p className="branch" style={{ gridArea: 'frame' }} data-on={on(['agent', 'perception'])}>
          Detections return bound to the frame’s hash
          {frame && <code>sha256 {frame.slice(0, 12)}…</code>}
        </p>
      </fieldset>
      <article className="schematic-detail" aria-live="polite">
        <h3>{chosen.name}</h3>
        <p className="schematic-role">{chosen.subtitle}</p>
        <p>{chosen.text}</p>
        <a href={`${source}/blob/main/${chosen.file}`}>Read this component</a>
      </article>
    </div>
  );
}
