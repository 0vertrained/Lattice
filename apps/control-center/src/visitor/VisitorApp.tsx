import { Component, lazy, type ReactNode, Suspense, useEffect, useRef, useState } from 'react';
import type { HandoffRecording } from './handoffTypes';
import type { Walkthrough } from './types';

const RecordedTwin = lazy(() => import('./RecordedTwin'));
const HandoffStory = lazy(() => import('./HandoffStory'));
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p>3D rendering is unavailable in this browser. Choose Map view to continue.</p>
    ) : (
      this.props.children
    );
  }
}
const chapters = [
  'Briefing',
  'Recorded mission',
  'Camera evidence',
  'Restart recovery',
  'Architecture',
] as const;
const source = 'https://github.com/0vertrained/Lattice';
const components = [
  {
    name: 'Operator',
    subtitle: 'Review the full objective',
    text: 'An operator signs in with OIDC and reviews every step and its failure policy. The approval identifies the exact plan digest. A viewer can inspect evidence without authorizing motion.',
    file: 'apps/control-center/src/features/missions/InspectionRound.tsx',
  },
  {
    name: 'Rust core',
    subtitle: 'Own identity and authorization',
    text: 'PostgreSQL commits approval, signed commands, sequences and audit records together. A changed core revision holds unfinished work and fences the previous writer. Model output has no execution authority.',
    file: 'crates/lattice-application/src/round.rs',
  },
  {
    name: 'Robot agent',
    subtitle: 'Verify before dispatch',
    text: 'A credential is bound to one body. The Rust agent verifies the Ed25519 signature, body, expiry and persisted sequence. Revocation, lost connectivity or a changed core epoch stops the local motion lease.',
    file: 'robots/lattice-ros2-body/src/main.rs',
  },
  {
    name: 'ROS 2 + Nav2',
    subtitle: 'Execute bounded movement',
    text: 'The C++ gateway forwards a verified goal to Nav2, tracks real map localization and enforces local speed and connection limits. A separate Gazebo deadman stops the motor when command updates disappear.',
    file: 'services/lattice-ros2-gateway/src/main.cpp',
  },
  {
    name: 'Perception',
    subtitle: 'Return evidence with uncertainty',
    text: 'After arrival, the rover captures a fresh RGB frame. A locally trained classifier evaluates marker candidates. The mission retains the image, model identity, timestamp and hashes, including when no marker is detected.',
    file: 'services/lattice-ai-gateway/app/vision.py',
  },
];
const fmt = (t: number) =>
  `${Math.floor(t / 60)}:${Math.floor(t % 60)
    .toString()
    .padStart(2, '0')}`;
export function VisitorApp() {
  const [run, setRun] = useState<Walkthrough | null>(null);
  const [handoffRun, setHandoffRun] = useState<HandoffRecording | null>(null);
  const [story, setStory] = useState<'single' | 'handoff'>(() =>
    window.location.hash === '#handoff' ? 'handoff' : 'single',
  );
  const [error, setError] = useState('');
  const [chapter, setChapter] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<'map' | '3d'>('map');
  const [speed, setSpeed] = useState(1);
  const [component, setComponent] = useState(1);
  const selectedComponent = components[component] ?? components[0];
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch(`${import.meta.env.BASE_URL}demo/walkthrough.json`, { signal: abort.signal })
      .then((r) => {
        if (!r.ok) throw new Error('Recorded mission unavailable');
        return r.json() as Promise<Walkthrough>;
      })
      .then(setRun)
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(e instanceof Error ? e.message : 'Unable to load recording');
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    fetch(`${import.meta.env.BASE_URL}demo/handoff.json`, { signal: abort.signal })
      .then((response) => (response.ok ? (response.json() as Promise<HandoffRecording>) : null))
      .then((recording) => {
        if (
          recording?.schema === 'lattice.handoff.v1' &&
          recording.handoff &&
          Array.isArray(recording.poses) &&
          recording.poses.length > 0 &&
          Array.isArray(recording.observations) &&
          Number.isFinite(recording.duration_s)
        ) {
          setHandoffRun(recording);
        }
      })
      .catch(() => {
        /* This second recording is optional on older deployments. */
      });
    return () => abort.abort();
  }, []);
  useEffect(() => {
    if (!playing || !run) return;
    let frame = 0;
    let previous = performance.now();
    const tick = (now: number) => {
      setTime((t) => Math.min(run.duration_s, t + ((now - previous) / 1000) * speed));
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, run, speed]);
  useEffect(() => {
    if (run && time >= run.duration_s) setPlaying(false);
  }, [run, time]);
  function go(index: number) {
    setChapter(index);
    setPlaying(false);
    setTimeout(() => heading.current?.focus(), 0);
  }
  const pose = run?.poses.findLast((p) => p.t <= time) ?? run?.poses[0];
  const event = run?.events.findLast((e) => e.t <= time);
  return (
    <div className="visitor-app">
      <a className="skip-link" href="#chapter">
        Skip to walkthrough
      </a>
      <header className="visitor-header">
        <a className="visitor-brand" href="./" aria-label="Lattice home">
          <span className="brand-symbol" aria-hidden="true">
            L
          </span>
          <span>
            LATTICE<small>Embodiment control plane</small>
          </span>
        </a>
        <nav aria-label="Site">
          <a href="https://0vertrained.github.io/#lattice">Portfolio</a>
          <a href={source}>Source</a>
          {import.meta.env.VITE_OPERATOR_ENABLED !== 'false' && (
            <a className="visitor-button quiet" href="./operator.html">
              Operator sign-in →
            </a>
          )}
        </nav>
      </header>
      <main>
        <section className="visitor-hero">
          <div>
            <p className="eyebrow">
              {story === 'handoff' && handoffRun
                ? 'Shared memory, measured continuation'
                : 'A warehouse objective, end to end'}
            </p>
            <h1>
              {story === 'handoff' && handoffRun
                ? 'Two bodies. One objective.'
                : 'Inspect. Find the exception.'}
              <br />
              <em>
                {story === 'handoff' && handoffRun ? 'The evidence stays.' : 'Recover and finish.'}
              </em>
            </h1>
            <p className="hero-description">
              {story === 'handoff' && handoffRun
                ? 'Rover A records an inspection. Rover B acknowledges its shared context and finishes the reviewed round. Follow both bodies through measured Gazebo poses and original camera evidence.'
                : 'Follow a rover through two safety inspections, a missing marker and a core restart. Every pose and camera image comes from the working Gazebo simulator.'}
            </p>
            <div className="visitor-actions">
              {story === 'handoff' && handoffRun ? (
                <a className="visitor-button primary" href="#chapter">
                  Explore this recording <span aria-hidden="true">→</span>
                </a>
              ) : (
                <button
                  type="button"
                  className="visitor-button primary"
                  onClick={() => {
                    setStory('single');
                    go(1);
                  }}
                >
                  Explore the mission <span aria-hidden="true">→</span>
                </button>
              )}
              <a className="visitor-button" href={`${source}/blob/main/docs/SHOWCASE.md`}>
                Run it yourself
              </a>
              {handoffRun && story !== 'handoff' && (
                <button
                  type="button"
                  className="visitor-button"
                  onClick={() => {
                    setStory('handoff');
                    setPlaying(false);
                  }}
                >
                  Explore two-rover handoff →
                </button>
              )}
            </div>
          </div>
          <div className="hero-notes">
            <p className="recorded-label">
              <span aria-hidden="true" /> Recorded simulation
            </p>
            <strong>
              One round.
              <br />
              {story === 'handoff' && handoffRun ? 'Two executing rovers.' : 'Three bounded steps.'}
            </strong>
            <p>
              {story === 'handoff' && handoffRun
                ? `${handoffRun.steps.length} reviewed steps. A retained inspection and explicit approval before a second rover continues.`
                : 'Two inspected locations. Camera evidence for both outcomes. A fresh approval before recovery.'}
            </p>
            <span className="scope-note">
              Interactive replay · no robot connection · no sign-in required
            </span>
          </div>
        </section>
        {error && (
          <p className="visitor-error" role="alert">
            {error}.{' '}
            <a href={`${source}/blob/main/docs/VALIDATION.md`}>Read the validation report.</a>
          </p>
        )}
        {!run && !error && <p role="status">Loading the recorded inspection round…</p>}
        {run && (
          <>
            {handoffRun && (
              <fieldset className="story-switch">
                <legend>Choose a recorded scenario</legend>
                <button
                  type="button"
                  className="visitor-button"
                  aria-pressed={story === 'single'}
                  onClick={() => {
                    setStory('single');
                    go(0);
                  }}
                >
                  Single-rover restart recovery
                </button>
                <button
                  type="button"
                  className="visitor-button"
                  aria-pressed={story === 'handoff'}
                  onClick={() => {
                    setStory('handoff');
                    setPlaying(false);
                  }}
                >
                  Shared memory · two-rover handoff
                </button>
              </fieldset>
            )}
            {story === 'handoff' && handoffRun ? (
              <Suspense
                fallback={<p role="status">Loading the recorded two-rover continuation…</p>}
              >
                <HandoffStory run={handoffRun} />
              </Suspense>
            ) : (
              <section className="visitor-workspace" aria-label="Guided walkthrough">
                <aside className="chapter-nav">
                  <p className="eyebrow">Inside the mission</p>
                  <nav aria-label="Walkthrough chapters">
                    {chapters.map((name, i) => (
                      <button
                        type="button"
                        key={name}
                        aria-current={chapter === i ? 'step' : undefined}
                        className={chapter === i ? 'selected' : ''}
                        onClick={() => go(i)}
                      >
                        <span>{String(i + 1).padStart(2, '0')}</span>
                        {name}
                        <span aria-hidden="true">→</span>
                      </button>
                    ))}
                  </nav>
                  <div className="run-facts">
                    <span>
                      Recorded{' '}
                      {new Date(run.recorded_at).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })}
                    </span>
                    <span>{fmt(run.duration_s)} elapsed</span>
                    <span>{run.distance_m.toFixed(1)} m reported path</span>
                    <a href={`${import.meta.env.BASE_URL}demo/walkthrough.json`} download>
                      Download the run →
                    </a>
                  </div>
                </aside>
                <div className="chapter-content" id="chapter">
                  <div className="chapter-heading">
                    <p className="eyebrow">
                      {String(chapter + 1).padStart(2, '0')} /{' '}
                      {String(chapters.length).padStart(2, '0')}
                    </p>
                    <h2 ref={heading} tabIndex={-1}>
                      {chapters[chapter]}
                    </h2>
                  </div>
                  {chapter === 0 && (
                    <>
                      <p className="chapter-lead">
                        The objective is bigger than arriving at a waypoint.
                      </p>
                      <p>
                        Inspect the bay, check the loading dock, and return to charge. The operator
                        reviews the complete sequence before dispatch, including what may continue
                        after an anomaly.
                      </p>
                      <ol className="brief-steps">
                        {run.steps.map((step, i) => (
                          <li key={step.title}>
                            <span className="step-number">{i + 1}</span>
                            <div>
                              <h3>{step.title}</h3>
                              <p>
                                {step.continue_on_missing_marker
                                  ? 'A validated image with no marker is recorded as an anomaly; the round may continue.'
                                  : 'Failure stops the round for review.'}
                              </p>
                              <code>{JSON.stringify(step.command)}</code>
                            </div>
                          </li>
                        ))}
                      </ol>
                      <div className="callout">
                        <strong>The interruption is part of the test.</strong>
                        <p>
                          During the return leg, the core process is killed. The rover must stop,
                          retain its work and wait for an operator to approve recovery.
                        </p>
                      </div>
                      <details>
                        <summary>Inspect the frozen approval</summary>
                        <p>
                          This round is operator-authored. The local vision model evaluates the
                          camera frames.
                        </p>
                        <dl>
                          <dt>Round</dt>
                          <dd>
                            <code>{run.round_id}</code>
                          </dd>
                          <dt>Plan digest</dt>
                          <dd>
                            <code>{run.digest}</code>
                          </dd>
                        </dl>
                      </details>
                    </>
                  )}
                  {chapter === 1 && (
                    <>
                      <div className="replay-caption">
                        <p>Actual map-frame telemetry</p>
                        <span>{pose?.status.replaceAll('_', ' ') ?? 'Waiting'}</span>
                      </div>
                      <fieldset className="view-switch" aria-label="Replay view">
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
                        <WarehouseMap run={run} time={time} />
                      ) : (
                        <SceneBoundary>
                          <Suspense fallback={<p>Loading the 3D reconstruction…</p>}>
                            <RecordedTwin run={run} time={time} />
                          </Suspense>
                        </SceneBoundary>
                      )}
                      <div className="replay-controls">
                        <button
                          type="button"
                          className="visitor-button primary"
                          aria-pressed={playing}
                          onClick={() => {
                            if (time >= run.duration_s) setTime(0);
                            setPlaying(!playing);
                          }}
                        >
                          {playing ? 'Pause replay' : 'Play replay'}
                        </button>
                        <label>
                          Recorded time{' '}
                          <output>
                            {fmt(time)} / {fmt(run.duration_s)}
                          </output>
                          <input
                            aria-label="Recorded mission time"
                            type="range"
                            min={0}
                            max={run.duration_s}
                            step={0.1}
                            value={time}
                            onChange={(e) => {
                              setPlaying(false);
                              setTime(Number(e.target.value));
                            }}
                          />
                        </label>
                        <label className="speed-label">
                          Speed
                          <select value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                            <option value={1}>1×</option>
                            <option value={3}>3×</option>
                            <option value={6}>6×</option>
                          </select>
                        </label>
                      </div>
                      <div className="telemetry-strip">
                        <span>
                          x <strong>{pose?.x.toFixed(2)} m</strong>
                        </span>
                        <span>
                          y <strong>{pose?.y.toFixed(2)} m</strong>
                        </span>
                        <span>
                          heading{' '}
                          <strong>{pose ? Math.round((pose.yaw * 180) / Math.PI) : 0}°</strong>
                        </span>
                      </div>
                      <div className="current-event">
                        <span className="eyebrow">At this point in the recording</span>
                        <h3>{event?.title ?? 'Round reviewed'}</h3>
                        <p>{event?.detail ?? 'The approved plan is ready for the rover.'}</p>
                      </div>
                      <nav className="event-track" aria-label="Jump to a recorded event">
                        {run.events.map((e) => (
                          <button
                            type="button"
                            key={`${e.kind}-${e.t}-${e.title}-${e.detail}`}
                            className={e.t <= time ? 'reached' : ''}
                            onClick={() => {
                              setPlaying(false);
                              setTime(e.t);
                            }}
                          >
                            <time>{fmt(e.t)}</time>
                            <span>{e.title}</span>
                            <small>{e.detail.length < 24 ? e.detail : e.kind}</small>
                          </button>
                        ))}
                      </nav>
                    </>
                  )}
                  {chapter === 2 && (
                    <>
                      <p className="chapter-lead">A missing marker is a result worth keeping.</p>
                      <div className="camera-grid">
                        {run.evidence.map((e) => (
                          <figure key={e.image}>
                            <div className="camera-label">
                              <span className={e.detections.length ? 'success' : 'anomaly'}>
                                {e.detections.length ? 'Marker detected' : 'No supported marker'}
                              </span>
                              <span>{e.outcome}</span>
                            </div>
                            <img
                              src={`${import.meta.env.BASE_URL}demo/${e.image}`}
                              width={320}
                              height={240}
                              alt={
                                e.detections.length
                                  ? 'Gazebo camera image with detected red safety marker'
                                  : 'Gazebo loading-dock camera image with no supported marker detected'
                              }
                            />
                            <figcaption>
                              <h3>{e.title}</h3>
                              <p>
                                {e.detections.length
                                  ? `Detector score ${((e.detections[0]?.confidence ?? 0) * 100).toFixed(1)}%. The inspection succeeded with evidence.`
                                  : 'The inspection failed with image evidence. Its reviewed policy allowed the round to continue.'}
                              </p>
                              <p className="scope-note">{e.confidence_domain}</p>
                              <details>
                                <summary>Model and image provenance</summary>
                                <p>{e.model_id}</p>
                                <code>JPEG SHA-256: {e.image_sha256}</code>
                                <code>Frame SHA-256: {e.frame_sha256}</code>
                              </details>
                              <a href={`${import.meta.env.BASE_URL}demo/${e.image}`} download>
                                Original annotated image →
                              </a>
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                      <div className="callout">
                        <strong>Measured model limits</strong>
                        <p>
                          The language classifier resolved 9 of 12 clear held-out requests and
                          abstained on all 24 negative cases. The marker detector reached 100%
                          precision and 98.3% recall on 600 synthetic crops. These results do not
                          establish physical-camera accuracy.
                        </p>
                        <a href={`${import.meta.env.BASE_URL}demo/evaluation.json`} download>
                          Read the full evaluation →
                        </a>
                      </div>
                    </>
                  )}
                  {chapter === 3 && (
                    <>
                      <p className="chapter-lead">
                        The process disappears. The mission context survives.
                      </p>
                      <div className="recovery-metrics">
                        <div>
                          <strong>
                            {run.recovery.stop_observed_after_s.toFixed(2)}
                            <small> s</small>
                          </strong>
                          <span>until the old motion was observed stopped</span>
                        </div>
                        <div>
                          <strong>
                            {(run.recovery.post_stop_drift_m * 100).toFixed(1)}
                            <small> cm</small>
                          </strong>
                          <span>reported drift after stopping</span>
                        </div>
                        <div>
                          <strong>{run.evidence.length}</strong>
                          <span>camera results retained after the restart</span>
                        </div>
                      </div>
                      <ol className="recovery-sequence">
                        <li>
                          <span>01</span>
                          <div>
                            <h3>Running → held</h3>
                            <p>
                              The body sees a changed core epoch and stops the previous goal.
                              PostgreSQL invalidates the old command and holds the round.
                            </p>
                          </div>
                        </li>
                        <li>
                          <span>02</span>
                          <div>
                            <h3>Operator reviews recovery</h3>
                            <p>
                              A fresh, expiring proposal names the held mission and the remaining
                              approved round. Reconnection alone cannot restart it.
                            </p>
                          </div>
                        </li>
                        <li>
                          <span>03</span>
                          <div>
                            <h3>New command → completed round</h3>
                            <p>
                              Approval creates a new command identity and higher sequence. The rover
                              reaches the charging station with its prior evidence intact.
                            </p>
                          </div>
                        </li>
                      </ol>
                      <p className="scope-note">
                        Measured in this simulator run. Local watchdogs also cover longer outages.
                        These are not hardware timing guarantees.
                      </p>
                    </>
                  )}
                  {chapter === 4 && (
                    <>
                      <p className="chapter-lead">Each component has a narrow authority.</p>
                      <nav
                        className="architecture-nodes"
                        aria-label="Explore architecture components"
                      >
                        {components.map((c, i) => (
                          <button
                            type="button"
                            key={c.name}
                            className={component === i ? 'selected' : ''}
                            aria-pressed={component === i}
                            onClick={() => setComponent(i)}
                          >
                            <span>{String(i + 1).padStart(2, '0')}</span>
                            {c.name}
                          </button>
                        ))}
                      </nav>
                      <article className="architecture-detail">
                        <p className="eyebrow">{selectedComponent?.name}</p>
                        <h3>{selectedComponent?.subtitle}</h3>
                        <p>{selectedComponent?.text}</p>
                        <a href={`${source}/blob/main/${selectedComponent?.file}`}>
                          Read this component →
                        </a>
                      </article>
                      <div className="engineering-notes">
                        <div>
                          <h3>What is implemented</h3>
                          <p>
                            Durable reviewed rounds, signed commands, body identity, OIDC roles,
                            fresh camera evidence, local motion limits and restart recovery.
                          </p>
                        </div>
                        <div>
                          <h3>What the evidence covers</h3>
                          <p>
                            One simulated warehouse, a small evaluated language corpus and a
                            synthetic marker classifier. Hardware, broader perception and
                            multi-fleet operation need separate validation.
                          </p>
                        </div>
                      </div>
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
                      onClick={() => go(chapter === 4 ? 0 : chapter + 1)}
                    >
                      {chapter === 4 ? 'Back to briefing' : 'Next chapter'} →
                    </button>
                  </div>
                </div>
              </section>
            )}
            <section className="visitor-bottom">
              <p className="eyebrow">Built by Rami Martinez</p>
              <h2>From model output to an observable robot outcome.</h2>
              <p>Explore the implementation, measured failures and the decisions behind them.</p>
              <a className="visitor-button" href="https://0vertrained.github.io/#lattice">
                Read the portfolio case study →
              </a>
            </section>
          </>
        )}
      </main>
      <footer className="visitor-footer">
        <span>Lattice · ROS 2 Jazzy / Gazebo Harmonic / Rust / Python</span>
        <span>Recorded evidence. No tracking.</span>
      </footer>
    </div>
  );
}
function WarehouseMap({ run, time }: { readonly run: Walkthrough; readonly time: number }) {
  const xy = (p: { x: number; y: number }) => `${(p.x + 5) * 68 + 30},${(4 - p.y) * 48 + 28}`;
  const current = run.poses.findLast((p) => p.t <= time) ?? run.poses[0];
  return (
    <svg
      className="warehouse-map"
      viewBox="0 0 740 440"
      role="img"
      aria-label="Recorded rover path through the warehouse, with the bay, loading dock and charging station"
    >
      <defs>
        <pattern id="map-grid" width="68" height="48" patternUnits="userSpaceOnUse">
          <path d="M68 0H0V48" fill="none" stroke="#1e3541" strokeWidth="1" />
        </pattern>
      </defs>
      <rect x="30" y="28" width="680" height="384" rx="10" className="warehouse-floor" />
      <rect x="30" y="28" width="680" height="384" fill="url(#map-grid)" />
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
      ].map((p) => (
        <g key={p.name} transform={`translate(${xy(p)})`}>
          <circle r="10" className="map-station" />
          <text y="-20" textAnchor="middle" className="map-label">
            {p.name}
          </text>
        </g>
      ))}
      <polyline points={run.poses.map(xy).join(' ')} className="route-full" />
      <polyline
        points={run.poses
          .filter((p) => p.t <= time)
          .map(xy)
          .join(' ')}
        className="route-played"
      />
      {current && (
        <g transform={`translate(${xy(current)})`}>
          <circle r="20" className="rover-halo" />
          <g transform={`rotate(${(-current.yaw * 180) / Math.PI})`}>
            <circle r="9" className="map-rover" />
            <path d="M0 -5L19 0L0 5" className="rover-arrow" />
          </g>
        </g>
      )}
      <text x="47" y="395" className="map-label">
        10 × 8 m · map frame
      </text>
    </svg>
  );
}
