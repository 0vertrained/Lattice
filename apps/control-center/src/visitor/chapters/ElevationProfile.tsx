import { minutes as fmt } from '../format';

const W = 720,
  H = 190,
  L = 64,
  R = 16,
  T = 18,
  B = 34;
const r1 = (value: number) => Math.round(value * 10) / 10;

/** A body's reported map-frame elevation, ruled every 5 cm and labelled every 10 cm, in step with the replay. */
export function ElevationProfile({
  samples,
  body,
  duration,
  time,
}: {
  readonly samples: readonly { readonly t: number; readonly z: number }[];
  readonly body: string;
  readonly duration: number;
  readonly time: number;
}) {
  if (!samples.length)
    return <p className="scope-note">Elevation telemetry is unavailable in this recording.</p>;
  const step = 0.05;
  const low = Math.floor(Math.min(0, ...samples.map((s) => s.z)) / step) * step;
  const high = Math.ceil(Math.max(0.2, ...samples.map((s) => s.z)) / step) * step;
  const x = (t: number) => r1(L + (t / duration) * (W - L - R));
  const y = (z: number) => r1(T + (1 - (z - low) / (high - low)) * (H - T - B));
  const line = (points: readonly { t: number; z: number }[]) =>
    points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t)} ${y(p.z)}`).join('');
  const current = samples.findLast((s) => s.t <= time);
  const ticks = Array.from(
    { length: Math.round((high - low) / step) + 1 },
    (_, i) => low + i * step,
  );
  return (
    <figure className="plate profile">
      <figcaption>
        {body} reported map elevation:{' '}
        <span className="figures">
          {current ? `${current.z.toFixed(3)} m at ${fmt(current.t)}` : 'awaiting the first sample'}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label="Measured quadruped map-frame elevation over the recording"
      >
        {ticks.map((z) => (
          <g key={z.toFixed(2)} className={Math.abs(z) < 1e-9 ? 'profile-zero' : 'profile-rule'}>
            <path d={`M${L} ${y(z)}H${W - R}`} />
            {Math.round(z * 100) % 10 === 0 && (
              <text x={L - 8} y={y(z) + 4} textAnchor="end">
                {`${(z * 100).toFixed(0)} cm`}
              </text>
            )}
          </g>
        ))}
        <g className="profile-axis">
          <text x={L} y={H - 10}>
            0:00
          </text>
          <text x={W - R} y={H - 10} textAnchor="end">
            {fmt(duration)}
          </text>
        </g>
        <path className="profile-full" d={line(samples)} />
        <path className="profile-played" d={line(samples.filter((s) => s.t <= time))} />
        <path className="profile-head" d={`M${x(Math.min(time, duration))} ${T - 6}V${H - B}`} />
      </svg>
    </figure>
  );
}
