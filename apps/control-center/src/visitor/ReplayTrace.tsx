import { useMemo } from 'react';
import type { Pose } from './drawing/geometry';

const W = 600,
  H = 64;

/** Speed between consecutive recorded samples, lightly smoothed; derived from the poses, not a separate sensor. */
export function speeds(samples: readonly Pose[]): { t: number; v: number }[] {
  const raw = samples.flatMap((pose, i) => {
    const previous = samples[i - 1];
    if (!previous || pose.t - previous.t < 0.05) return [];
    return [
      {
        t: pose.t,
        v: Math.hypot(pose.x - previous.x, pose.y - previous.y) / (pose.t - previous.t),
      },
    ];
  });
  return raw.map((sample, i) => {
    const window = raw.slice(Math.max(0, i - 2), i + 3);
    return { t: sample.t, v: window.reduce((sum, item) => sum + item.v, 0) / window.length };
  });
}

/** Recorded time as a slider laid over the speed trace, with the recorded events marked beneath. */
export function ReplayTrace({
  series,
  events,
  time,
  duration,
  label,
  onSeek,
}: {
  readonly series: readonly { t: number; v: number }[];
  readonly events: readonly { t: number; kind: string; title: string; detail: string }[];
  readonly time: number;
  readonly duration: number;
  readonly label: string;
  readonly onSeek: (time: number) => void;
}) {
  const x = (t: number) => Math.round((t / duration) * W * 10) / 10;
  const trace = useMemo(() => {
    const top = Math.max(0.05, ...series.map((sample) => sample.v));
    return series
      .map((sample, i) => {
        const px = Math.round((sample.t / duration) * W * 10) / 10,
          py = Math.round((H - 14 - (sample.v / top) * (H - 22)) * 10) / 10;
        return `${i ? 'L' : 'M'}${px} ${py}`;
      })
      .join('');
  }, [series, duration]);
  return (
    <div className="trace">
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
        <path className="trace-base" d={`M0 ${H - 14}H${W}`} vectorEffect="non-scaling-stroke" />
        {trace && <path className="trace-speed" d={trace} vectorEffect="non-scaling-stroke" />}
        {events.map((event) => (
          <path
            key={`${event.kind}-${event.t}-${event.title}-${event.detail}`}
            className={`trace-event trace-${event.kind}`}
            d={`M${x(event.t)} ${H - 10}V${H}`}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        <path className="trace-head" d={`M${x(time)} 0V${H}`} vectorEffect="non-scaling-stroke" />
      </svg>
      <input
        aria-label={label}
        type="range"
        min={0}
        max={duration}
        step={0.1}
        value={time}
        onChange={(event) => onSeek(Number(event.target.value))}
      />
    </div>
  );
}
