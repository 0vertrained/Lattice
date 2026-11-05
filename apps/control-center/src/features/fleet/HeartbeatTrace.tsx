import { LATE_MS, tracePath } from './heartbeats';

const W = 240;
const H = 44;

/**
 * Heartbeats as a short oscilloscope trace: a beat wherever a report arrived in the last 30 seconds.
 * After the core's heartbeat timeout without a report, the line runs on flat and dashed.
 */
export function HeartbeatTrace({
  beats,
  now,
  offline,
  label,
}: {
  readonly beats: readonly number[];
  readonly now: number;
  readonly offline: boolean;
  readonly label: string;
}) {
  const { live, tail } = tracePath(beats, now, W);
  const late = offline || (beats.at(-1) ?? 0) < now - LATE_MS;
  return (
    <svg
      className="heartbeat"
      data-late={late ? '' : undefined}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
    >
      <path className="heartbeat-grid" d={`M0 30H${W}M60 4V40M120 4V40M180 4V40`} />
      {live && <path className="heartbeat-live" d={live} />}
      {tail && <path className="heartbeat-tail" d={`M${tail.from} 30H${tail.to}`} />}
    </svg>
  );
}
