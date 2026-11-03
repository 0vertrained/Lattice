import { useId } from 'react';
import { minutes as fmt } from '../format';

const W = 960,
  X0 = 120,
  X1 = 940,
  ROW = 64,
  TOP = 44;
const r1 = (value: number) => Math.round(value * 10) / 10;

export interface Channel {
  readonly label: string;
  readonly tone: 'ink' | 'body';
  /** Speed over time; the channel is high wherever the body was measured moving. */
  readonly speeds: readonly { readonly t: number; readonly v: number }[];
}
export interface Marker {
  readonly t: number;
  readonly label: string;
}

/** Above this measured speed a body counts as moving; below it, sensor noise while standing. */
const MOVING = 0.04;

/**
 * The run as a logic analyser: one digital channel per body, high while it was measured moving, with
 * markers at recorded moments and a hatched band where the first body's work was held for review.
 */
export function LogicTrace({
  channels,
  markers,
  held,
  duration,
  label,
}: {
  readonly channels: readonly Channel[];
  readonly markers: readonly Marker[];
  /** From the hold to the approval, drawn across the first channel. */
  readonly held: { readonly from: number; readonly to: number } | null;
  readonly duration: number;
  readonly label: string;
}) {
  const hatch = `${useId().replaceAll(':', '')}-held`;
  const x = (t: number) => r1(X0 + (Math.min(Math.max(t, 0), duration) / duration) * (X1 - X0));
  const bottom = TOP + channels.length * ROW;
  const H = bottom + 80;
  const step = duration > 120 ? 20 : duration > 40 ? 10 : 5;
  const ticks = Array.from({ length: Math.floor(duration / step) + 1 }, (_, i) => i * step);
  const level = (row: number, moving: boolean) => r1(TOP + row * ROW + (moving ? 14 : 44));
  const trace = (channel: Channel, row: number) => {
    let moving = false;
    let d = `M${X0} ${level(row, false)}`;
    for (const sample of channel.speeds) {
      const now = sample.v > MOVING;
      if (now !== moving) {
        d += `H${x(sample.t)}V${level(row, now)}`;
        moving = now;
      }
    }
    return `${d}H${X1}`;
  };
  // A marker close to the one before it takes the second label line.
  const placed = markers
    .slice()
    .sort((a, b) => a.t - b.t)
    .map((marker, index, all) => ({
      ...marker,
      lift: index > 0 && x(marker.t) - x(all[index - 1]?.t ?? 0) < 160 ? 1 : 0,
    }));
  return (
    <figure className="plate logic">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
        <defs>
          <pattern
            id={hatch}
            width="8"
            height="8"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <path d="M0 0V8" />
          </pattern>
        </defs>
        <g className="logic-axis">
          {ticks.map((t) => (
            <g key={t}>
              <path d={`M${x(t)} ${TOP - 10}V${bottom}`} />
              <text x={x(t)} y={TOP - 18}>
                {fmt(t)}
              </text>
            </g>
          ))}
        </g>
        {held && (
          <rect
            className="logic-held"
            x={x(held.from)}
            y={TOP + 6}
            width={Math.max(2, x(held.to) - x(held.from))}
            height={ROW - 12}
            fill={`url(#${hatch})`}
          />
        )}
        {channels.map((channel, row) => (
          <g key={channel.label} className={`logic-channel logic-${channel.tone}`}>
            <text className="logic-label" x={0} y={TOP + row * ROW + 34}>
              {channel.label}
            </text>
            <path className="logic-base" d={`M${X0} ${level(row, false)}H${X1}`} />
            <path className="logic-wave" d={trace(channel, row)} />
          </g>
        ))}
        {placed.map((marker) => (
          <g key={`${marker.label}-${marker.t}`} className="logic-marker">
            <path d={`M${x(marker.t)} ${TOP}V${bottom + 10 + marker.lift * 34}`} />
            <text x={x(marker.t) + 6} y={bottom + 26 + marker.lift * 34}>
              {marker.label}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  );
}
