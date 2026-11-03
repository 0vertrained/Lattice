import { Component, type ReactNode, Suspense, useEffect, useState } from 'react';
import { sampleAt } from '../drawing/geometry';
import { LatticeDrawing } from '../drawing/LatticeDrawing';
import type { Scene } from '../drawing/scenes';
import { minutes as fmt, signed } from '../format';
import { ReplayTrace } from './ReplayTrace';

export interface RecordedEvent {
  readonly t: number;
  readonly kind: string;
  readonly title: string;
  readonly detail: string;
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p className="replay-fallback">
        3D rendering is unavailable in this browser. Choose Map view to continue.
      </p>
    ) : (
      this.props.children
    );
  }
}

/** Where each body on the map was at a recorded time, as replay readouts. */
export function bodyReadouts(scene: Scene, time: number): [string, string][] {
  return scene.tracks.map((track) => {
    const first = track.samples[0];
    const pose = sampleAt(track.samples, time);
    return [
      track.label,
      !first || !pose || time < first.t
        ? 'Not yet reporting'
        : `${signed(pose.x, 2)}, ${signed(pose.y, 2)} m`,
    ];
  });
}

/** A recorded run on the map (or in 3D), scrubbed on its speed trace, with live readouts and events. */
export function ReplayPanel({
  caption,
  scene,
  label,
  twin,
  duration,
  events,
  series,
  name,
  play,
  pause,
  readouts,
  idle,
  eventsLabel,
  speeds = [1, 3, 6],
  initialSpeed,
  children,
}: {
  readonly caption: string;
  readonly scene: Scene;
  /** What the map shows, for screen readers. */
  readonly label: string;
  /** The 3D reconstruction at a recorded time, when the story has one. */
  readonly twin?: (time: number) => ReactNode;
  readonly duration: number;
  readonly events: readonly RecordedEvent[];
  /** Speed over time for each body on the map. */
  readonly series: readonly (readonly { t: number; v: number }[])[];
  /** The slider's name, such as "Recorded mission time". */
  readonly name: string;
  readonly play: string;
  readonly pause: string;
  readonly readouts: (time: number) => readonly (readonly [string, string])[];
  /** Shown as the latest event before the first one is reached. */
  readonly idle: { readonly title: string; readonly detail: string };
  readonly eventsLabel: string;
  readonly speeds?: readonly number[];
  readonly initialSpeed?: number;
  /** Parts kept in step with the replay, such as a measured profile. */
  readonly children?: (time: number) => ReactNode;
}) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<'map' | '3d'>('map');
  const [speed, setSpeed] = useState(initialSpeed ?? speeds[0] ?? 1);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      setTime((t) => Math.min(duration, t + ((now - previous) / 1000) * speed));
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, duration, speed]);
  useEffect(() => {
    if (time >= duration) setPlaying(false);
  }, [duration, time]);
  const seek = (next: number) => {
    setPlaying(false);
    setTime(next);
  };
  const event = events.findLast((item) => item.t <= time);
  return (
    <div className="replay">
      <div className="replay-main">
        <div className="replay-bar">
          <p>{caption}</p>
          {twin && (
            <fieldset className="segmented" aria-label="Replay view">
              <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>
                Map view
              </button>
              <button type="button" aria-pressed={view === '3d'} onClick={() => setView('3d')}>
                3D replay
              </button>
            </fieldset>
          )}
        </div>
        <div className="plate replay-plate">
          {view === '3d' && twin ? (
            <SceneBoundary>
              <Suspense
                fallback={<p className="replay-fallback">Loading the 3D reconstruction…</p>}
              >
                {twin(time)}
              </Suspense>
            </SceneBoundary>
          ) : (
            <LatticeDrawing scene={scene} mode="replay" time={time} label={label} />
          )}
        </div>
        <div className="replay-controls">
          <button
            type="button"
            className="button primary"
            onClick={() => {
              if (time >= duration) setTime(0);
              setPlaying(!playing);
            }}
          >
            {playing ? pause : play}
          </button>
          <ReplayTrace
            series={series}
            events={events}
            time={time}
            duration={duration}
            label={name}
            onSeek={seek}
          />
          <label className="speed">
            Speed
            <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
              {speeds.map((value) => (
                <option key={value} value={value}>
                  {value}×
                </option>
              ))}
            </select>
          </label>
        </div>
        {children?.(time)}
      </div>
      <aside className="readout-panel" aria-label="Replay readouts">
        <dl className="readouts">
          <div>
            <dt>Time</dt>
            <dd>
              {fmt(time)} / {fmt(duration)}
            </dd>
          </div>
          {readouts(time).map(([term, value]) => (
            <div key={term}>
              <dt>{term}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="latest-event">
          <p>Latest event</p>
          <h3>{event?.title ?? idle.title}</h3>
          <p>{event?.detail ?? idle.detail}</p>
        </div>
      </aside>
      <nav className="event-track" aria-label={eventsLabel}>
        {events.map((item) => (
          <button
            type="button"
            key={`${item.kind}-${item.t}-${item.title}-${item.detail}`}
            className={item.t <= time ? 'reached' : ''}
            onClick={() => seek(item.t)}
          >
            <time>{fmt(item.t)}</time>
            <span>{item.title}</span>
            <small>{item.detail.length < 24 ? item.detail : item.kind}</small>
          </button>
        ))}
      </nav>
    </div>
  );
}
