/** A 3 × 3 route lattice with one lane drawn through it, stepping up like the stair route. */
export function LatticeMark() {
  return (
    <svg className="lattice-mark" viewBox="0 0 32 32" aria-hidden="true">
      <path className="mark-grid" d="M6 6H26M6 16H26M6 26H26M6 6V26M16 6V26M26 6V26" />
      <path className="mark-lane-edge" d="M6 26H16V16H26V6" />
      <path className="mark-lane" d="M6 26H16V16H26V6" />
      <path
        className="mark-node"
        d="M4 4h4v4H4zM14 4h4v4h-4zM24 4h4v4h-4zM4 14h4v4H4zM14 14h4v4h-4zM24 14h4v4h-4zM4 24h4v4H4zM14 24h4v4h-4zM24 24h4v4h-4z"
      />
    </svg>
  );
}
