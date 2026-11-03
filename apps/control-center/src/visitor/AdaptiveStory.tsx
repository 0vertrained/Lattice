import './chapters/chapters.css';
import './stories.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AdaptiveMap } from './AdaptiveMap';
import {
  type AdaptiveRecording,
  type AdaptiveScan,
  type AdaptiveVideo,
  adaptiveScanSchema,
  adaptiveVideoSchema,
} from './adaptiveTypes';
import { CapabilityMap, ElevationProfile } from './CapabilityStory';

const chapters = [
  'A new route condition',
  'Reviewed continuity',
  'Measured continuation',
  'Evidence and limits',
] as const;
const fmt = (time: number) =>
  `${Math.floor(time / 60)}:${Math.floor(time % 60)
    .toString()
    .padStart(2, '0')}`;
const name = (id: string, run: AdaptiveRecording) =>
  id === run.handoff.source_body_id
    ? 'Gazebo rover'
    : id === run.handoff.target_body_id
      ? 'MuJoCo Go1'
      : id;
const asset = (file: string) => `${import.meta.env.BASE_URL}demo/${file}`;

export default function AdaptiveStory({ run }: { readonly run: AdaptiveRecording }) {
  const [chapter, setChapter] = useState(0),
    [original, setOriginal] = useState(true);
  const [time, setTime] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(4);
  const [scan, setScan] = useState<AdaptiveScan | null>(null),
    [scanError, setScanError] = useState('');
  const [video, setVideo] = useState<AdaptiveVideo | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const retained = run.observations.filter((observation) =>
    run.replan.retained_observation_ids.includes(observation.id),
  );
  const condition = run.condition_observation;
  const placeName = (id: string) =>
    run.map.places.find((place) => place.id === id)?.label ?? id.replaceAll('_', ' ');
  const timeline = useMemo(
    () =>
      run.events
        .map((entry) => {
          const timestamp =
            entry.kind === 'condition'
              ? run.condition_observation.received_at
              : entry.kind === 'replan'
                ? run.replan.created_at
                : entry.kind === 'memory'
                  ? run.handoff.context_acknowledged_at
                  : entry.kind === 'approval' && entry.title === 'Revised remainder approved'
                    ? run.replan.approved_at
                    : entry.kind === 'approval' && entry.title === 'Go1 continuation approved'
                      ? run.handoff.approved_at
                      : null;
          return timestamp
            ? {
                ...entry,
                t: Math.max(0, (Date.parse(timestamp) - Date.parse(run.recorded_at)) / 1000),
              }
            : entry;
        })
        .sort((a, b) => a.t - b.t),
    [run],
  );
  const event = timeline.findLast((entry) => entry.t <= time);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    setScan(null);
    setScanError('');
    fetch(asset(run.lidar_scan.file), { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('The recorded scan is unavailable.');
        const bytes = await response.arrayBuffer();
        const hash = Array.from(
          new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
          (value) => value.toString(16).padStart(2, '0'),
        ).join('');
        if (hash !== run.lidar_scan.sha256)
          throw new Error('The scan does not match the authenticated condition hash.');
        const parsed = adaptiveScanSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
        if (
          parsed.ranges.length !== run.lidar_scan.samples ||
          parsed.sensor_frame_id !== run.lidar_scan.sensor_frame_id
        )
          throw new Error('The scan metadata does not match this recording.');
        if (!abort.signal.aborted) setScan(parsed);
      })
      .catch((error) => {
        if (!abort.signal.aborted)
          setScanError(error instanceof Error ? error.message : 'Unable to verify the scan.');
      });
    return () => abort.abort();
  }, [run.lidar_scan]);
  useEffect(() => {
    const abort = new AbortController();
    setVideo(null);
    fetch(asset('adaptive-quadruped.provenance.json'), { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        const parsed = adaptiveVideoSchema.safeParse(await response.json());
        return parsed.success &&
          parsed.data.source_round_id === run.round_id &&
          parsed.data.map_digest === run.plan.map_digest
          ? parsed.data
          : null;
      })
      .then((value) => {
        if (!abort.signal.aborted) setVideo(value);
      })
      .catch(() => {
        /* Same-run physics media is optional; another mission's clip is never substituted. */
      });
    return () => abort.abort();
  }, [run.round_id, run.plan.map_digest]);
  useEffect(() => {
    if (!playing) return;
    let frame = 0,
      previous = performance.now();
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
  }, [time, run.duration_s]);
  function go(index: number) {
    setChapter(index);
    setPlaying(false);
    setTimeout(() => heading.current?.focus(), 0);
  }
  return (
    <section
      className="visitor-workspace capability-story adaptive-story"
      aria-label="Adaptive route walkthrough"
    >
      <aside className="chapter-nav">
        <p className="eyebrow">Keep the goal. Review the change.</p>
        <nav aria-label="Adaptive route chapters">
          {chapters.map((title, index) => (
            <button
              type="button"
              key={title}
              className={chapter === index ? 'selected' : ''}
              aria-current={chapter === index ? 'step' : undefined}
              onClick={() => go(index)}
            >
              <span>{String(index + 1).padStart(2, '0')}</span>
              {title}
              <span aria-hidden="true">→</span>
            </button>
          ))}
        </nav>
        <div className="run-facts">
          <span>Recorded {new Date(run.recorded_at).toLocaleDateString()}</span>
          <span>{run.mission_duration_s.toFixed(1)} s objective completed</span>
          <span>{run.duration_s.toFixed(1)} s recorded, including the standing interval</span>
          <span>{run.adaptation.completed_steps_preserved} completed inspection preserved</span>
          <span>{run.adaptation.repeated_inspections} repeated source inspections</span>
          <span>
            {run.quadruped.step_count} × {(run.quadruped.riser_height_m * 100).toFixed(0)} cm
            simulated risers
          </span>
          <a href={asset('adaptive-route.json')} download>
            Download the adaptive run →
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
            <p className="chapter-lead">The aisle is blocked. The inspection still counts.</p>
            <p>
              The rover completes its bay inspection, then reports lidar returns blocking the
              reviewed direct segment. Its local controller stops, and Lattice holds the same
              objective. The remaining route can change without repeating the completed inspection
              or discarding its camera evidence.
            </p>
            <fieldset className="view-switch" aria-label="Adaptive route comparison">
              <button
                type="button"
                className="visitor-button quiet"
                aria-pressed={original}
                onClick={() => setOriginal(true)}
              >
                Original route
              </button>
              <button
                type="button"
                className="visitor-button quiet"
                aria-pressed={!original}
                onClick={() => setOriginal(false)}
              >
                Reviewed detour
              </button>
            </fieldset>
            <AdaptiveMap run={run} scan={scan} original={original} />
            {!scan && !scanError && (
              <p role="status" className="scope-note">
                Verifying the original lidar scan before drawing its returns…
              </p>
            )}
            {scanError && (
              <p className="visitor-error" role="alert">
                {scanError} The route diagram remains available without a scan overlay.
              </p>
            )}
            {scan && (
              <p className="scope-note">
                Original scan hash verified · {scan.ranges.length} samples in {scan.sensor_frame_id}{' '}
                · recorded acquisition-time sensor transform.
              </p>
            )}
            <div className="recovery-metrics">
              <div>
                <strong>
                  {condition.evidence?.distance_m.toFixed(2)}
                  <small> m</small>
                </strong>
                <span>Nearest reported corridor return</span>
              </div>
              <div>
                <strong>{condition.evidence?.blocked_samples}</strong>
                <span>Laser returns supporting the block report</span>
              </div>
              <div>
                <strong>{run.replan.conditions_revision}</strong>
                <span>Condition revision bound to the new review</span>
              </div>
            </div>
            <div className="callout">
              <strong>What the laser observation establishes</strong>
              <p>{condition.reason}</p>
              <p>
                The evaluator inserted a collision-enabled box into Gazebo after staging, outside
                the static occupancy map. The robot reported a blocked path from its real simulated
                lidar; it did not classify the object as a box. The scan remains available
                independently of this diagram.
              </p>
              <a href={asset(run.lidar_scan.file)} download>
                Download the original scan →
              </a>
            </div>
            <button type="button" className="visitor-button primary" onClick={() => go(1)}>
              Review what changed and what stayed →
            </button>
          </>
        )}
        {chapter === 1 && (
          <>
            <p className="chapter-lead">A new remainder. The same objective.</p>
            <p>
              The original destination remains {placeName(run.objective.route.destination_place_id)}
              . The planner excludes the blocked segment and proposes the west bypass. An operator
              reviews the exact remaining steps while the original source authorization expires;
              approval also requires fresh source telemetry after that stop fence.
            </p>
            <div className="adaptive-work-columns">
              <div>
                <h3>Completed work preserved</h3>
                <ol className="brief-steps">
                  {run.replan.completed_steps.map((step, index) => (
                    <li key={step.title}>
                      <span className="step-number">{index + 1}</span>
                      <div>
                        <h3>{step.title}</h3>
                        <p>Preserved in the same round, with its original observation.</p>
                      </div>
                    </li>
                  ))}
                </ol>
                {retained.map((observation) => (
                  <figure className="adaptive-retained" key={observation.id}>
                    <img
                      src={asset(observation.image)}
                      width={320}
                      height={240}
                      alt="Original bay inspection retained across the route replan"
                    />
                    <figcaption>
                      Accepted before the blocked segment; retained through the detour and the later
                      body transfer.{' '}
                      <a href={asset(observation.image)} download>
                        Original JPEG →
                      </a>
                    </figcaption>
                  </figure>
                ))}
              </div>
              <div>
                <h3>New remaining assignments</h3>
                <ol className="brief-steps">
                  {run.replan.remaining_steps.map((step, index) => (
                    <li key={step.title}>
                      <span className="step-number">
                        {index + run.replan.completed_steps.length + 1}
                      </span>
                      <div>
                        <h3>{step.title.replaceAll('_', ' ')}</h3>
                        <p>
                          {name(run.replan.step_body_ids[index] ?? '', run)}
                          {step.command.type === 'traverse_route'
                            ? ` · ${step.command.traversal.required_capabilities.join(' + ')} required`
                            : ' · capture a new accepted inspection'}
                        </p>
                      </div>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
            <div className="callout">
              <strong>The later capability transfer is still a separate decision</strong>
              <p>
                After the rover finishes the detour, Go1 receives its own reviewed handoff at the
                stair landing. Retained image hashes and context are verified before the receiving
                body continues. Approving a replacement route never automatically approves that
                transfer.
              </p>
            </div>
            <details className="capability-proof">
              <summary>Inspect the preserved objective and new review binding</summary>
              <dl>
                <dt>Same round</dt>
                <dd>
                  <code>{run.round_id}</code>
                </dd>
                <dt>Previous round SHA-256</dt>
                <dd>
                  <code>{run.replan.round_digest}</code>
                </dd>
                <dt>Replacement review SHA-256</dt>
                <dd>
                  <code>{run.replan.digest}</code>
                </dd>
                <dt>Source authorization fence ended</dt>
                <dd>{new Date(run.replan.not_before_at).toLocaleString()}</dd>
                <dt>Replacement approved</dt>
                <dd>
                  {run.replan.approved_at
                    ? new Date(run.replan.approved_at).toLocaleString()
                    : 'not recorded'}
                </dd>
                <dt>Review expiry</dt>
                <dd>{new Date(run.replan.expires_at).toLocaleString()}</dd>
                <dt>Retained observation identities</dt>
                <dd>{run.replan.retained_observation_ids.join(', ')}</dd>
              </dl>
            </details>
            <button type="button" className="visitor-button primary" onClick={() => go(2)}>
              Watch the measured continuation →
            </button>
          </>
        )}
        {chapter === 2 && (
          <>
            {video && (
              <figure className="capability-video">
                <video
                  controls
                  muted
                  playsInline
                  preload="none"
                  poster={asset(video.video.poster)}
                  width={video.video.width}
                  height={video.video.height}
                  aria-label="Recorded Go1 joint-state replay from the adaptive mission"
                >
                  <source src={asset('adaptive-quadruped.mp4')} type="video/mp4" />
                </video>
                <figcaption>
                  External-camera replay of Go1 joint states measured during this adaptive mission.
                  The {video.video.duration_s.toFixed(1)} s clip has its own player; the timeline
                  below covers the full objective.{' '}
                  <a href={asset('adaptive-quadruped.provenance.json')} download>
                    Replay provenance →
                  </a>
                </figcaption>
              </figure>
            )}
            <div className="replay-caption">
              <p>Measured adapter poses · original objective retained</p>
              <span>{run.outcome}</span>
            </div>
            <CapabilityMap run={run} time={time} />
            <div className="handoff-legend">
              <span>
                <i className="body-a-dot" />
                Gazebo rover · reviewed detour
              </span>
              <span>
                <i className="body-b-dot" />
                MuJoCo Go1 · stair continuation
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
                {playing ? 'Pause adaptive replay' : 'Play adaptive replay'}
              </button>
              <label>
                Adaptive replay time
                <output>
                  {fmt(time)} / {fmt(run.duration_s)}
                </output>
                <input
                  type="range"
                  min="0"
                  max={run.duration_s}
                  step="0.001"
                  value={time}
                  aria-label="Adaptive replay time"
                  onChange={(entry) => {
                    setPlaying(false);
                    setTime(Number(entry.target.value));
                  }}
                />
              </label>
              <label>
                Playback speed
                <select
                  aria-label="Adaptive replay speed"
                  value={speed}
                  onChange={(entry) => setSpeed(Number(entry.target.value))}
                >
                  {[1, 2, 4, 8].map((value) => (
                    <option value={value} key={value}>
                      {value}×
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="current-event" aria-live="polite">
              <span>{fmt(event?.t ?? 0)}</span>
              <h3>{event?.title ?? 'Adaptive recording ready'}</h3>
              <p>{event?.detail ?? 'Play the recording or choose a recorded event.'}</p>
            </div>
            <div className="event-track">
              {timeline.map((entry) => (
                <button
                  type="button"
                  key={`${entry.t}-${entry.kind}-${entry.title}-${entry.detail}`}
                  className={entry.t <= time ? 'reached' : ''}
                  onClick={() => {
                    setPlaying(false);
                    setTime(entry.t);
                  }}
                >
                  <time>{fmt(entry.t)}</time>
                  {entry.title}
                </button>
              ))}
            </div>
            <p className="scope-note">
              Condition receipt, review creation, approval and context acknowledgement use their
              stored timestamps. Mission events show when polling observed them; polling order does
              not establish actuation order. The final standing interval is included.
            </p>
            <ElevationProfile run={run} time={time} />
            <button type="button" className="visitor-button primary" onClick={() => go(3)}>
              Inspect the original evidence and limits →
            </button>
          </>
        )}
        {chapter === 3 && (
          <>
            <p className="chapter-lead">Inspect the evidence behind the outcome.</p>
            <div className="camera-grid">
              {run.observations.map((observation) => (
                <figure key={observation.id}>
                  <div className="camera-label">
                    <span className={observation.outcome === 'detected' ? 'success' : 'anomaly'}>
                      {observation.outcome === 'detected'
                        ? 'Marker detected'
                        : 'No supported marker'}
                    </span>
                    <span>{name(observation.body_id, run)}</span>
                  </div>
                  <img
                    src={asset(observation.image)}
                    width={320}
                    height={240}
                    alt={`Accepted ${name(observation.body_id, run)} camera at ${observation.location.replaceAll('_', ' ')}`}
                  />
                  <figcaption>
                    <h3>{placeName(observation.location)}</h3>
                    <p>
                      {observation.confidence == null
                        ? 'No supported detection score.'
                        : `Detector score ${(observation.confidence * 100).toFixed(1)}%.`}
                    </p>
                    <p className="scope-note">{observation.confidence_domain}</p>
                    <details>
                      <summary>Adaptive inspection provenance</summary>
                      <p>
                        Observation <code>{observation.id}</code>
                      </p>
                      <p>
                        Mission <code>{observation.mission_id}</code>
                      </p>
                      <p>Captured {new Date(observation.captured_at).toLocaleString()}</p>
                      <code>JPEG SHA-256: {observation.image_sha256}</code>
                      <code>Frame SHA-256: {observation.frame_sha256}</code>
                    </details>
                    <a href={asset(observation.image)} download>
                      Original recorded image →
                    </a>
                  </figcaption>
                </figure>
              ))}
            </div>
            <div className="recovery-metrics">
              <div>
                <strong>
                  {run.adaptation.replan_proposal_ms.toFixed(1)}
                  <small> ms</small>
                </strong>
                <span>Prepare-review request time, including transport and persistence</span>
              </div>
              <div>
                <strong>
                  {run.adaptation.hold_to_approval_s.toFixed(1)}
                  <small> s</small>
                </strong>
                <span>Observed hold to explicit replan approval, including the source fence</span>
              </div>
              <div>
                <strong>
                  {(run.adaptation.source_drift_while_held_m * 100).toFixed(2)}
                  <small> cm</small>
                </strong>
                <span>Maximum sampled source drift while awaiting replan approval</span>
              </div>
            </div>
            <details className="capability-proof">
              <summary>Inspect scan, context and route provenance</summary>
              <dl>
                <dt>Authenticated condition</dt>
                <dd>
                  <code>{condition.id}</code>
                </dd>
                <dt>Bound source command</dt>
                <dd>
                  <code>{condition.command_id}</code>
                </dd>
                <dt>Scan observed</dt>
                <dd>{new Date(condition.observed_at).toLocaleString()}</dd>
                <dt>Scan SHA-256</dt>
                <dd>
                  <code>{run.lidar_scan.sha256}</code>
                </dd>
                <dt>Final round SHA-256</dt>
                <dd>
                  <code>{run.digest}</code>
                </dd>
                <dt>Shared handoff context SHA-256</dt>
                <dd>
                  <code>{run.handoff.context_digest}</code>
                </dd>
                <dt>Controller</dt>
                <dd>
                  {run.quadruped.controller} · {run.quadruped.engine}
                </dd>
                <dt>Measured step contacts</dt>
                <dd>{run.quadruped.contact_steps.join(', ')}</dd>
              </dl>
              <a href={asset(run.lidar_scan.file)} download>
                Download the original laser scan →
              </a>
            </details>
            <div className="callout">
              <strong>What this establishes, and where it stops</strong>
              <p>
                A physical obstacle in Gazebo produces an authenticated lidar condition, a held
                objective and an explicitly approved detour with completed work preserved. Go1 then
                completes a separate reviewed continuation in MuJoCo over {run.quadruped.step_count}{' '}
                risers of {(run.quadruped.riser_height_m * 100).toFixed(0)} cm each. The simulators
                share semantic coordinates; they do not share inter-body collision physics.
              </p>
              <p>
                Planning is deterministic over a configured graph. The third-party Walk These Ways
                policy supplies locomotion, and inspection uses a classifier for synthetic markers.
                This is bounded simulation evidence, not unrestricted navigation or
                physical-hardware validation.
              </p>
              <a href="https://github.com/0vertrained/Lattice/blob/main/simulation/quadruped/THIRD_PARTY.md">
                Controller attribution →
              </a>
              <p>
                <a href="https://github.com/0vertrained/Lattice/blob/main/evaluation/adaptive-missions-2026-11-02.json">
                  Compare the recorded scenario outcomes and development failure →
                </a>
              </p>
            </div>
            <a className="visitor-button" href={asset('adaptive-route.json')} download>
              Download the complete adaptive record →
            </a>
          </>
        )}
        <div className="chapter-footer">
          <span>{String(chapter + 1).padStart(2, '0')} / 04</span>
          <button
            type="button"
            className="visitor-button quiet"
            onClick={() => go(chapter === 3 ? 0 : chapter + 1)}
          >
            {chapter === 3 ? 'Back to the new condition' : `Next: ${chapters[chapter + 1]}`} →
          </button>
        </div>
      </div>
    </section>
  );
}
