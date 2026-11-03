import {
  Component,
  lazy,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { AdaptiveRecording } from './adaptiveTypes';
import type { CapabilityRecording } from './capabilityTypes';
import { LatticeDrawing } from './drawing/LatticeDrawing';
import { type StoryId, singleScene } from './drawing/scenes';
import { minutes as fmt, signed } from './format';
import type { HandoffRecording } from './handoffTypes';
import { ReplayTrace, speeds } from './ReplayTrace';
import { SiteHeader } from './SiteHeader';
import { StoryLine } from './StoryLine';
import { type Recordings, StoryOpening } from './StoryOpening';
import type { Walkthrough } from './types';

const RecordedTwin = lazy(() => import('./RecordedTwin'));
const HandoffStory = lazy(() => import('./HandoffStory'));
const CapabilityStory = lazy(() => import('./CapabilityStory'));
const AdaptiveStory = lazy(() => import('./AdaptiveStory'));
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

interface Load<T> {
  readonly data: T | null;
  readonly done: boolean;
}
/** Fetches one recording; `accept` returns null for anything that is not a complete, consistent recording. */
function useRecording<T>(
  file: string,
  accept: (value: unknown) => T | null | Promise<T | null>,
): Load<T> {
  const [state, setState] = useState<Load<T>>({ data: null, done: false });
  useEffect(() => {
    const abort = new AbortController();
    fetch(`${import.meta.env.BASE_URL}demo/${file}`, { signal: abort.signal })
      .then(async (response) => (response.ok ? accept(await response.json()) : null))
      .then((data) => {
        if (!abort.signal.aborted) setState({ data, done: true });
      })
      .catch(() => {
        if (!abort.signal.aborted) setState({ data: null, done: true });
      });
    return () => abort.abort();
  }, [file, accept]);
  return state;
}
const acceptWalkthrough = (value: unknown) => value as Walkthrough;
const acceptHandoff = (value: unknown) => {
  const recording = value as HandoffRecording | null;
  /* This second recording is optional on older deployments. */
  return recording?.schema === 'lattice.handoff.v1' &&
    recording.handoff &&
    Array.isArray(recording.poses) &&
    recording.poses.length > 0 &&
    Array.isArray(recording.observations) &&
    Number.isFinite(recording.duration_s)
    ? recording
    : null;
};
/* The capability scenario appears only when its completed recording is available. */
const acceptCapability = async (value: unknown): Promise<CapabilityRecording | null> => {
  const { capabilityRecordingSchema } = await import('./capabilityTypes');
  const parsed = capabilityRecordingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
/* Only a complete, consistent adaptive recording is offered as a scenario. */
const acceptAdaptive = async (value: unknown): Promise<AdaptiveRecording | null> => {
  const { adaptiveRecordingSchema } = await import('./adaptiveTypes');
  const parsed = adaptiveRecordingSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};
const storyFromHash = (): StoryId =>
  !window.location.hash || window.location.hash === '#adaptive'
    ? 'adaptive'
    : window.location.hash === '#capability'
      ? 'capability'
      : window.location.hash === '#handoff'
        ? 'handoff'
        : 'single';

export function VisitorApp() {
  const single = useRecording('walkthrough.json', acceptWalkthrough);
  const handoff = useRecording('handoff.json', acceptHandoff);
  const capability = useRecording('capability-route.json', acceptCapability);
  const adaptive = useRecording('adaptive-route.json', acceptAdaptive);
  const run = single.data;
  const [story, setStory] = useState<StoryId>(storyFromHash);
  const [chapter, setChapter] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [view, setView] = useState<'map' | '3d'>('map');
  const [speed, setSpeed] = useState(1);
  const [component, setComponent] = useState(1);
  const selectedComponent = components[component] ?? components[0];
  const heading = useRef<HTMLHeadingElement>(null);
  const loads = { single, handoff, capability, adaptive };
  // A story whose recording is still loading keeps its place; one that failed falls back to the single rover.
  const shown: StoryId = loads[story].data || !loads[story].done ? story : 'single';
  const recordings: Recordings = useMemo(
    () => ({
      single: single.data,
      handoff: handoff.data,
      capability: capability.data,
      adaptive: adaptive.data,
    }),
    [single.data, handoff.data, capability.data, adaptive.data],
  );
  const durations = Object.fromEntries(
    Object.entries(recordings).flatMap(([id, recording]) =>
      recording ? [[id, recording.duration_s]] : [],
    ),
  ) as Partial<Record<StoryId, number>>;
  const map = useMemo(() => run && singleScene(run), [run]);
  const samples = map?.tracks[0]?.samples ?? [];
  const series = useMemo(() => speeds(samples), [samples]);
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
  function select(next: StoryId) {
    setStory(next);
    setPlaying(false);
    if (next === 'single') go(0);
  }
  const pose = run?.poses.findLast((p) => p.t <= time) ?? run?.poses[0];
  const event = run?.events.findLast((e) => e.t <= time);
  const velocity = series.findLast((sample) => sample.t <= time)?.v ?? 0;
  return (
    <div className="visitor-app">
      <a className="skip-link" href="#chapter">
        Skip to walkthrough
      </a>
      <SiteHeader source={source} operator={import.meta.env.VITE_OPERATOR_ENABLED !== 'false'} />
      <main>
        <StoryOpening
          story={shown}
          recordings={recordings}
          source={source}
          onExplore={() => {
            setStory('single');
            go(1);
          }}
        />
        {single.done && !run && (
          <p className="visitor-error" role="alert">
            The recorded mission is unavailable.{' '}
            <a href={`${source}/blob/main/docs/VALIDATION.md`}>Read the validation report.</a>
          </p>
        )}
        {!single.done && <p role="status">Loading the recorded inspection round…</p>}
        {run && (
          <>
            <StoryLine current={shown} durations={durations} onSelect={select} />
            {shown === 'adaptive' ? (
              adaptive.data ? (
                <Suspense fallback={<p role="status">Loading the recorded adaptive route…</p>}>
                  <AdaptiveStory run={adaptive.data} />
                </Suspense>
              ) : (
                <p role="status">Loading the recorded adaptive route…</p>
              )
            ) : shown === 'capability' ? (
              capability.data ? (
                <Suspense fallback={<p role="status">Loading the recorded capability route…</p>}>
                  <CapabilityStory run={capability.data} />
                </Suspense>
              ) : (
                <p role="status">Loading the recorded capability route…</p>
              )
            ) : shown === 'handoff' ? (
              handoff.data ? (
                <Suspense
                  fallback={<p role="status">Loading the recorded two-rover continuation…</p>}
                >
                  <HandoffStory run={handoff.data} />
                </Suspense>
              ) : (
                <p role="status">Loading the recorded two-rover continuation…</p>
              )
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
                      Download the run
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
                  {chapter === 1 && map && (
                    <div className="replay">
                      <div className="replay-main">
                        <div className="replay-bar">
                          <p>Map-frame telemetry from the recorded run</p>
                          <fieldset className="segmented" aria-label="Replay view">
                            <button
                              type="button"
                              aria-pressed={view === 'map'}
                              onClick={() => setView('map')}
                            >
                              Map view
                            </button>
                            <button
                              type="button"
                              aria-pressed={view === '3d'}
                              onClick={() => setView('3d')}
                            >
                              3D replay
                            </button>
                          </fieldset>
                        </div>
                        <div className="plate replay-plate">
                          {view === 'map' ? (
                            <LatticeDrawing
                              scene={map}
                              mode="replay"
                              time={time}
                              label="Recorded rover path through the warehouse, with the bay, loading dock and charging station"
                            />
                          ) : (
                            <SceneBoundary>
                              <Suspense fallback={<p>Loading the 3D reconstruction…</p>}>
                                <RecordedTwin run={run} time={time} />
                              </Suspense>
                            </SceneBoundary>
                          )}
                        </div>
                        <div className="replay-controls">
                          <button
                            type="button"
                            className="button primary"
                            aria-pressed={playing}
                            onClick={() => {
                              if (time >= run.duration_s) setTime(0);
                              setPlaying(!playing);
                            }}
                          >
                            {playing ? 'Pause replay' : 'Play replay'}
                          </button>
                          <ReplayTrace
                            series={series}
                            events={run.events}
                            time={time}
                            duration={run.duration_s}
                            label="Recorded mission time"
                            onSeek={(next) => {
                              setPlaying(false);
                              setTime(next);
                            }}
                          />
                          <label className="speed">
                            Speed
                            <select
                              value={speed}
                              onChange={(e) => setSpeed(Number(e.target.value))}
                            >
                              <option value={1}>1×</option>
                              <option value={3}>3×</option>
                              <option value={6}>6×</option>
                            </select>
                          </label>
                        </div>
                      </div>
                      <aside className="readout-panel" aria-label="Replay readouts">
                        <dl className="readouts">
                          <div>
                            <dt>Time</dt>
                            <dd>
                              {fmt(time)} / {fmt(run.duration_s)}
                            </dd>
                          </div>
                          <div>
                            <dt>Position</dt>
                            <dd>{pose ? `${signed(pose.x, 2)}, ${signed(pose.y, 2)} m` : '–'}</dd>
                          </div>
                          <div>
                            <dt>Heading</dt>
                            <dd>{signed(pose ? (pose.yaw * 180) / Math.PI : 0, 0)}°</dd>
                          </div>
                          <div>
                            <dt>Speed</dt>
                            <dd>{velocity.toFixed(2)} m/s</dd>
                          </div>
                          <div>
                            <dt>State</dt>
                            <dd>{pose?.status.replaceAll('_', ' ') ?? 'waiting'}</dd>
                          </div>
                        </dl>
                        <div className="latest-event">
                          <p>Latest event</p>
                          <h3>{event?.title ?? 'Round reviewed'}</h3>
                          <p>{event?.detail ?? 'The approved plan is ready for the rover.'}</p>
                        </div>
                      </aside>
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
                    </div>
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
                                Original annotated image
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
                          Read the full evaluation
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
                          Read this component
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
                      Previous
                    </button>
                    <span>{chapters[chapter]}</span>
                    <button
                      type="button"
                      className="visitor-button"
                      onClick={() => go(chapter === 4 ? 0 : chapter + 1)}
                    >
                      {chapter === 4 ? 'Back to briefing' : 'Next chapter'}
                    </button>
                  </div>
                </div>
              </section>
            )}
            <section className="visitor-bottom">
              <p>Built by Rami Martinez</p>
              <h2>From model output to an observable robot outcome.</h2>
              <p>Explore the implementation, measured failures and the decisions behind them.</p>
              <a className="button" href="https://0vertrained.github.io/#lattice">
                Read the portfolio case study
              </a>
            </section>
          </>
        )}
      </main>
      <footer className="visitor-footer">
        <span>Lattice, built on ROS 2 Jazzy, Gazebo Harmonic, Rust and Python.</span>
        <span>Recorded evidence. No tracking.</span>
      </footer>
    </div>
  );
}
