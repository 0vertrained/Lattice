import { Component, lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import type { HandoffRecording } from './handoffTypes';

const RecordedTwin = lazy(() => import('./RecordedTwin'));
const chapters = [
  'Shared objective',
  'Two-rover replay',
  'Shared memory',
  'Handoff proof',
] as const;
const fmt = (time: number) =>
  `${Math.floor(time / 60)}:${Math.floor(time % 60)
    .toString()
    .padStart(2, '0')}`;
const stationName = (value: string) => value.replaceAll('_', ' ');
const bodyName = (id: string, run: HandoffRecording) =>
  id === run.handoff.source_body_id
    ? 'Rover A'
    : id === run.handoff.target_body_id
      ? 'Rover B'
      : id;

class ReplayBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p>3D rendering is unavailable. Choose Map view to continue the replay.</p>
    ) : (
      this.props.children
    );
  }
}

export default function HandoffStory({ run }: { readonly run: HandoffRecording }) {
  const [chapter, setChapter] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(2);
  const [view, setView] = useState<'map' | '3d'>('map');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  const event = run.events.findLast((item) => item.t <= time);
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      setTime((current) => Math.min(run.duration_s, current + ((now - previous) / 1000) * speed));
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, run.duration_s, speed]);
  useEffect(() => {
    if (time >= run.duration_s) setPlaying(false);
  }, [run.duration_s, time]);
  function go(index: number) {
    setChapter(index);
    setPlaying(false);
    setTimeout(() => heading.current?.focus(), 0);
  }
  return (
    <section
      className="visitor-workspace handoff-story"
      aria-label="Two-rover continuation walkthrough"
    >
      <aside className="chapter-nav">
        <p className="eyebrow">One objective, two bodies</p>
        <nav aria-label="Two-rover chapters">
          {chapters.map((name, index) => (
            <button
              type="button"
              key={name}
              aria-current={chapter === index ? 'step' : undefined}
              className={chapter === index ? 'selected' : ''}
              onClick={() => go(index)}
            >
              <span>{String(index + 1).padStart(2, '0')}</span>
              {name}
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </nav>
        <div className="run-facts">
          <span>Recorded {new Date(run.recorded_at).toLocaleDateString()}</span>
          <span>
            {fmt(run.duration_s)} elapsed · {run.outcome}
          </span>
          {Object.entries(run.distance_by_body_m).map(([id, distance]) => (
            <span key={id}>
              {bodyName(id, run)} · {distance.toFixed(1)} m reported path
            </span>
          ))}
          <a href={`${import.meta.env.BASE_URL}demo/handoff.json`} download>
            Download the handoff run →
          </a>
        </div>
      </aside>
      <div className="chapter-content" id="chapter">
        <div className="chapter-heading">
          <p className="eyebrow">{String(chapter + 1).padStart(2, '0')} / 04</p>
          <h2 ref={heading} tabIndex={-1}>
            {chapters[chapter]}
          </h2>
        </div>
        {chapter === 0 && (
          <>
            <p className="chapter-lead">
              The body changes. The objective and its evidence survive.
            </p>
            <p>
              Rover A inspects the bay, then begins the next leg. An operator holds its round and
              reviews a transfer. After A’s execution window closes, rover B receives the remaining
              steps and acknowledges the retained observation context.
            </p>
            <div className="handoff-body-flow">
              <div>
                <span className="body-a-dot" />
                Rover A<small>Observes the bay · retires its command</small>
              </div>
              <span aria-hidden="true">→</span>
              <div>
                <span className="body-b-dot" />
                Rover B<small>Acknowledges context · completes the round</small>
              </div>
            </div>
            <ol className="brief-steps">
              {run.steps.map((step, index) => (
                <li key={step.title}>
                  <span className="step-number">{index + 1}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>
                      {index < run.handoff.completed_steps
                        ? 'Completed before handoff; its evidence stays in shared memory.'
                        : step.continue_on_missing_marker
                          ? 'Continued by rover B; a validated no-marker image records an anomaly.'
                          : 'Continued by rover B under the reviewed transfer.'}
                    </p>
                    <code>{JSON.stringify(step.command)}</code>
                  </div>
                </li>
              ))}
            </ol>
            <div className="callout">
              <strong>What this demonstrates</strong>
              <p>
                Continuity between two independently executing simulated rover instances in one
                warehouse. This run uses the same body type and adapter; transfer to a quadruped,
                drone or physical robot requires separate validation.
              </p>
            </div>
            <button type="button" className="visitor-button primary" onClick={() => go(1)}>
              Watch the two-body continuation →
            </button>
          </>
        )}
        {chapter === 1 && (
          <>
            <div className="replay-caption">
              <p>Recorded map-frame telemetry · both body instances</p>
              <span>{run.outcome}</span>
            </div>
            <fieldset className="view-switch" aria-label="Two-rover replay view">
              <button
                type="button"
                className="visitor-button quiet"
                aria-pressed={view === 'map'}
                onClick={() => setView('map')}
              >
                Map view
              </button>
              <button
                type="button"
                className="visitor-button quiet"
                aria-pressed={view === '3d'}
                onClick={() => setView('3d')}
              >
                3D replay
              </button>
            </fieldset>
            {view === 'map' ? (
              <HandoffMap run={run} time={time} />
            ) : (
              <ReplayBoundary>
                <Suspense fallback={<p>Loading the two-rover reconstruction…</p>}>
                  <RecordedTwin run={run} time={time} />
                </Suspense>
              </ReplayBoundary>
            )}
            <div className="handoff-legend">
              <span>
                <i className="body-a-dot" />
                Rover A · source
              </span>
              <span>
                <i className="body-b-dot" />
                Rover B · continuation
              </span>
            </div>
            <div className="replay-controls">
              <button
                type="button"
                className="visitor-button"
                onClick={() => {
                  if (time >= run.duration_s) setTime(0);
                  setPlaying((value) => !value);
                }}
              >
                {playing ? 'Pause handoff replay' : 'Play handoff replay'}
              </button>
              <label>
                Handoff replay time
                <output>
                  {fmt(time)} / {fmt(run.duration_s)}
                </output>
                <input
                  aria-label="Handoff replay time"
                  type="range"
                  min={0}
                  max={run.duration_s}
                  step="any"
                  value={time}
                  onChange={(event) => {
                    setTime(Number(event.target.value));
                    setPlaying(false);
                  }}
                />
              </label>
              <label className="speed-label">
                Speed
                <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                  <option value={1}>1×</option>
                  <option value={2}>2×</option>
                  <option value={4}>4×</option>
                </select>
              </label>
            </div>
            <div className="current-event">
              <p className="eyebrow">Recorded event</p>
              <h3>{event?.title ?? 'Two bodies registered'}</h3>
              <p>
                {event?.detail ?? 'The operator-authored round is ready for explicit approval.'}
              </p>
            </div>
            <nav className="event-track" aria-label="Jump to a handoff event">
              {run.events.map((item) => (
                <button
                  type="button"
                  key={`${item.t}-${item.kind}-${item.title}-${item.detail}`}
                  className={item.t <= time ? 'reached' : ''}
                  onClick={() => {
                    setTime(item.t);
                    setPlaying(false);
                  }}
                >
                  <time>{fmt(item.t)}</time>
                  <span>{item.title}</span>
                  <small>{item.kind}</small>
                </button>
              ))}
            </nav>
            <p className="scope-note">
              Interactive replay of measured simulation poses. The reconstructed scene does not show
              live robots or generate new camera observations.
            </p>
          </>
        )}
        {chapter === 2 && <RecordedMemory run={run} />}
        {chapter === 3 && (
          <>
            <p className="chapter-lead">The second body receives an objective with a past.</p>
            <div className="recovery-metrics">
              <div>
                <strong>
                  {run.handoff.source_stop_observed_after_s.toFixed(2)}
                  <small> s</small>
                </strong>
                <span>until source motion was observed stopped</span>
              </div>
              <div>
                <strong>
                  {(run.handoff.post_stop_drift_m * 100).toFixed(1)}
                  <small> cm</small>
                </strong>
                <span>reported source drift after stopping</span>
              </div>
              <div>
                <strong>{run.handoff.remaining_steps}</strong>
                <span>remaining reviewed steps transferred</span>
              </div>
            </div>
            <ol className="recovery-sequence">
              <li>
                <span>01</span>
                <div>
                  <h3>Hold the round and retire A’s command</h3>
                  <p>
                    The proposal freezes source, target, completed steps and observation references.
                    The old body loses execution renewal; approval waits through its signed command
                    window and stop margin.
                  </p>
                </div>
              </li>
              <li>
                <span>02</span>
                <div>
                  <h3>Approve the exact continuation</h3>
                  <p>
                    An operator approves the immutable digest. The core rechecks B’s availability
                    and capabilities before dispatching the remaining task.
                  </p>
                </div>
              </li>
              <li>
                <span>03</span>
                <div>
                  <h3>B acknowledges the shared context</h3>
                  <p>
                    The target checks the signed context and acknowledges its digest. The original
                    image remains historical evidence; the new inspection produces its own frame and
                    result.
                  </p>
                </div>
              </li>
            </ol>
            <div className="callout">
              <strong>
                {run.outcome === 'completed'
                  ? 'The recorded round completed.'
                  : `Recorded outcome: ${run.outcome}.`}
              </strong>
              <p>
                {run.anomaly_count} recorded {run.anomaly_count === 1 ? 'anomaly' : 'anomalies'}.{' '}
                {run.observations.length} camera observations retained across the two bodies.
              </p>
            </div>
            <details>
              <summary>Inspect the recorded approval and acknowledgement</summary>
              <dl>
                <dt>Round</dt>
                <dd>
                  <code>{run.round_id}</code>
                </dd>
                <dt>Plan digest</dt>
                <dd>
                  <code>{run.digest}</code>
                </dd>
                <dt>Handoff</dt>
                <dd>
                  <code>{run.handoff.id}</code>
                </dd>
                <dt>Context digest acknowledged by B</dt>
                <dd>
                  <code>{run.handoff.context_digest}</code>
                </dd>
                <dt>Source / target</dt>
                <dd>
                  <code>
                    {run.handoff.source_body_id} → {run.handoff.target_body_id}
                  </code>
                </dd>
                <dt>Earliest approval</dt>
                <dd>{new Date(run.handoff.not_before_at).toLocaleString()}</dd>
                <dt>Approved</dt>
                <dd>{new Date(run.handoff.approved_at).toLocaleString()}</dd>
                <dt>Context acknowledged</dt>
                <dd>{new Date(run.handoff.context_acknowledged_at).toLocaleString()}</dd>
              </dl>
            </details>
            <p className="scope-note">
              Measured in this simulator run. Reported stop time and drift are observations from
              this recording, not hardware timing guarantees. Shared context contains retained
              observation references, not a learned world model.
            </p>
          </>
        )}
        <div className="chapter-footer">
          <button
            type="button"
            className="visitor-button quiet"
            disabled={chapter === 0}
            onClick={() => go(chapter - 1)}
          >
            ← Previous
          </button>
          <span>{chapters[chapter]}</span>
          <button
            type="button"
            className="visitor-button"
            onClick={() => go(chapter === chapters.length - 1 ? 0 : chapter + 1)}
          >
            {chapter === chapters.length - 1 ? 'Back to objective' : 'Next chapter'} →
          </button>
        </div>
      </div>
    </section>
  );
}

function RecordedMemory({ run }: { readonly run: HandoffRecording }) {
  const stations = [...new Set(run.observations.map((item) => item.location))];
  const [station, setStation] = useState(stations[0] ?? 'inspection_bay');
  const observations = run.observations
    .filter((item) => item.location === station)
    .sort((a, b) => Date.parse(b.captured_at) - Date.parse(a.captured_at));
  const lastSeen = observations.find((item) => item.outcome === 'detected');
  const latestNegative = observations.find(
    (item) =>
      item.outcome === 'not_detected' &&
      (!lastSeen || Date.parse(item.captured_at) > Date.parse(lastSeen.captured_at)),
  );
  const shown = [lastSeen, latestNegative].filter((item) => item !== undefined);
  return (
    <>
      <p className="chapter-lead">Ask what the fleet remembers.</p>
      <p>
        Query the observations captured in this recording. A station’s last positive sighting
        remains distinct from a later image with no supported detection.
      </p>
      <label className="recorded-memory-select">
        Recorded memory query
        <select
          aria-label="Recorded memory query"
          value={station}
          onChange={(event) => setStation(event.target.value)}
        >
          {stations.map((location) => (
            <option value={location} key={location}>
              Safety marker at {stationName(location)}
            </option>
          ))}
        </select>
      </label>
      {!lastSeen && (
        <p className="recorded-memory-empty" role="status">
          No positive safety-marker sighting was recorded at this station.
        </p>
      )}
      <div className="camera-grid">
        {shown.map((observation) => (
          <figure key={observation.id}>
            <div className="camera-label">
              <span className={observation.outcome === 'detected' ? 'success' : 'anomaly'}>
                {observation.outcome === 'detected'
                  ? 'Last positive sighting'
                  : 'No supported marker'}
              </span>
              <span>{bodyName(observation.body_id, run)}</span>
            </div>
            <img
              src={`${import.meta.env.BASE_URL}demo/${observation.image}`}
              width={320}
              height={240}
              alt={`Recorded ${bodyName(observation.body_id, run)} camera at ${stationName(observation.location)}; ${observation.outcome === 'detected' ? 'marker detected' : 'no supported marker detected'}`}
            />
            <figcaption>
              <h3>{stationName(observation.location)}</h3>
              <p>
                {observation.confidence === null
                  ? 'No detection score. This image does not establish absence across the entire station.'
                  : `Detector score ${(observation.confidence * 100).toFixed(1)}%.`}
              </p>
              <p className="scope-note">{observation.confidence_domain}</p>
              <p>
                Captured{' '}
                <time dateTime={observation.captured_at}>
                  {new Date(observation.captured_at).toLocaleString()}
                </time>
              </p>
              <details>
                <summary>Shared observation provenance</summary>
                <p>
                  Subject: <code>{observation.subject_key}</code>
                </p>
                <p>
                  Model: <code>{observation.model_id}</code>
                </p>
                <p>
                  Body: <code>{observation.body_id}</code>
                </p>
                <p>
                  Observation: <code>{observation.id}</code>
                </p>
                <p>
                  Mission: <code>{observation.mission_id}</code>
                </p>
                <p>
                  Command: <code>{observation.command_id}</code>
                </p>
                <p>Received: {new Date(observation.received_at).toLocaleString()}</p>
                <p>
                  Observer pose in {observation.map_frame}:{' '}
                  {observation.observer_pose
                    ? `x ${observation.observer_pose.x.toFixed(2)} m, y ${observation.observer_pose.y.toFixed(2)} m, yaw ${observation.observer_pose.yaw.toFixed(2)} rad`
                    : 'not available'}
                </p>
                <code>JPEG SHA-256: {observation.image_sha256}</code>
                <code>Frame SHA-256: {observation.frame_sha256}</code>
              </details>
              <a href={`${import.meta.env.BASE_URL}demo/${observation.image}`} download>
                Original recorded image →
              </a>
            </figcaption>
          </figure>
        ))}
      </div>
      <div className="callout">
        <strong>History with provenance</strong>
        <p>
          These images were captured during the recorded missions. Scrubbing the replay does not
          create a new frame. The map position belongs to the observing rover; it does not locate
          the marker in 3D.
        </p>
      </div>
    </>
  );
}

function HandoffMap({ run, time }: { readonly run: HandoffRecording; readonly time: number }) {
  const xy = (pose: { x: number; y: number }) =>
    `${(pose.x + 5) * 68 + 30},${(4 - pose.y) * 48 + 28}`;
  return (
    <svg
      className="warehouse-map"
      viewBox="0 0 740 440"
      role="img"
      aria-label="Recorded paths of rover A and rover B in the shared warehouse map"
    >
      <rect x="30" y="28" width="680" height="384" rx="10" className="warehouse-floor" />
      <rect
        x={30 + 6.65 * 68}
        y={28 + 3.1 * 48}
        width={0.7 * 68}
        height={1.8 * 48}
        rx="4"
        className="warehouse-shelf"
      />
      <text x="506" y="279" className="map-label" textAnchor="middle">
        Occupied shelf
      </text>
      {[
        { x: 0, y: 2.5, name: 'Inspection bay' },
        { x: 3.5, y: 0, name: 'Loading dock' },
        { x: -3, y: -2, name: 'Charging station' },
      ].map((station) => (
        <g key={station.name} transform={`translate(${xy(station)})`}>
          <circle r="10" className="map-station" />
          <text y="-20" textAnchor="middle" className="map-label">
            {station.name}
          </text>
        </g>
      ))}
      {[run.handoff.source_body_id, run.handoff.target_body_id].map((id, index) => {
        const poses = run.poses.filter((pose) => pose.body_id === id);
        const current = poses.findLast((pose) => pose.t <= time) ?? poses[0];
        const color = index === 0 ? '#83dfb8' : '#87b8e6';
        return (
          <g key={id}>
            <polyline points={poses.map(xy).join(' ')} className="route-full" />
            <polyline
              points={poses
                .filter((pose) => pose.t <= time)
                .map(xy)
                .join(' ')}
              className="route-played"
              style={{ stroke: color }}
            />
            {current && (
              <g transform={`translate(${xy(current)})`}>
                <circle r="20" className="rover-halo" />
                <g transform={`rotate(${(-current.yaw * 180) / Math.PI})`}>
                  <circle r="9" className="map-rover" style={{ fill: color }} />
                  <path d="M0 -5L19 0L0 5" className="rover-arrow" style={{ fill: color }} />
                </g>
                <text y="32" textAnchor="middle" className="map-label" style={{ fill: color }}>
                  {bodyName(id, run)}
                </text>
              </g>
            )}
          </g>
        );
      })}
      <text x="47" y="395" className="map-label">
        10 × 8 m · shared map frame · recorded poses
      </text>
    </svg>
  );
}
