import './chapters/chapters.css';
import './stories.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type CapabilityRecording,
  type CapabilityVideo,
  capabilityVideoSchema,
} from './capabilityTypes';

const chapters = [
  'Capability decision',
  'Measured traversal',
  'Camera continuity',
  'Approval and limits',
] as const;
const fmt = (time: number) =>
  `${Math.floor(time / 60)}:${Math.floor(time % 60)
    .toString()
    .padStart(2, '0')}`;
const bodyName = (id: string, run: Pick<CapabilityRecording, 'handoff'>) =>
  id === run.handoff.source_body_id
    ? 'Gazebo rover'
    : id === run.handoff.target_body_id
      ? 'MuJoCo Go1'
      : id;
const artifact = `${import.meta.env.BASE_URL}demo/capability-route.json`;

export default function CapabilityStory({
  run,
}: {
  readonly run: CapabilityRecording;
  readonly opened?: unknown;
}) {
  const [chapter, setChapter] = useState(0);
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [video, setVideo] = useState<CapabilityVideo | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const timeline = useMemo(
    () =>
      run.events
        .map((entry) => {
          const timestamp =
            entry.kind === 'memory'
              ? run.handoff.context_acknowledged_at
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
  const completedAt = run.events.find((entry) => entry.kind === 'complete')?.t;
  const placeName = (id: string) =>
    run.map.places.find((place) => place.id === id)?.label ?? id.replaceAll('_', ' ');
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    fetch(`${import.meta.env.BASE_URL}demo/capability-quadruped.provenance.json`, {
      signal: abort.signal,
    })
      .then(async (response) => {
        if (!response.ok) return null;
        const value: unknown = await response.json();
        const parsed = capabilityVideoSchema.safeParse(value);
        return parsed.success &&
          parsed.data.source_round_id === run.round_id &&
          parsed.data.map_digest === run.plan.map_digest
          ? parsed.data
          : null;
      })
      .then((recording) => {
        if (!abort.signal.aborted) setVideo(recording);
      })
      .catch(() => {
        /* The mission remains inspectable when the optional physics replay is unavailable. */
      });
    return () => abort.abort();
  }, [run.round_id, run.plan.map_digest]);
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
      className="visitor-workspace capability-story"
      aria-label="Capability route walkthrough"
    >
      <aside className="chapter-nav">
        <p className="eyebrow">One objective, different capabilities</p>
        <nav aria-label="Capability route chapters">
          {chapters.map((name, index) => (
            <button
              key={name}
              type="button"
              className={chapter === index ? 'selected' : ''}
              aria-current={chapter === index ? 'step' : undefined}
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
            {completedAt !== undefined
              ? `${completedAt.toFixed(1)} s objective completed`
              : run.outcome}
          </span>
          <span>{run.duration_s.toFixed(1)} s recorded, including the final standing interval</span>
          <span>
            {run.steps.length} reviewed steps · {run.plan.transfers.length} body transfer
          </span>
          <span>
            {run.quadruped.step_count} × {(run.quadruped.riser_height_m * 100).toFixed(0)} cm
            simulated risers
          </span>
          {Object.entries(run.distance_by_body_m).map(([id, distance]) => (
            <span key={id}>
              {bodyName(id, run)} · {distance.toFixed(2)} m reported path
            </span>
          ))}
          <a href={artifact} download>
            Download the capability run →
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
            <p className="chapter-lead">The route needs stairs. The rover needs another body.</p>
            <p>
              A rover inspects the ground-floor bay and reaches a transfer point. The deterministic
              planner assigns the next segment to a staged Go1 with stairs capability. An operator
              reviews the route, then approves the actual transfer after the rover stops and the
              receiving body is checked again.
            </p>
            <p>
              This run uses {run.quadruped.step_count} simulated risers, each{' '}
              {(run.quadruped.riser_height_m * 100).toFixed(0)} cm high, with the pretrained Walk
              These Ways controller in MuJoCo.
            </p>
            <div className="handoff-body-flow">
              <div>
                <span className="body-a-dot" />
                Gazebo rover<small>Inspect the bay · reach the transfer point</small>
              </div>
              <span aria-hidden="true">→</span>
              <div>
                <span className="body-b-dot" />
                MuJoCo Go1<small>Acknowledge memory · traverse stairs · inspect above</small>
              </div>
            </div>
            <ol className="brief-steps">
              {run.steps.map((step, index) => (
                <li key={step.title}>
                  <span className="step-number">{index + 1}</span>
                  <div>
                    <h3>{step.title}</h3>
                    <p>
                      {bodyName(run.step_body_ids[index] ?? '', run)}
                      {step.command.type === 'traverse_route'
                        ? ` · ${step.command.traversal.required_capabilities.join(' + ')} required`
                        : ' · retain the accepted camera evidence'}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
            {run.plan.transfers.map((transfer) => (
              <div className="callout" key={`${transfer.place_id}-${transfer.target_body_id}`}>
                <strong>Why the body changes at {placeName(transfer.place_id)}</strong>
                <p>{transfer.reason}</p>
                <p>
                  The replacement was already staged at this permitted transfer point. Planning did
                  not send it there automatically.
                </p>
              </div>
            ))}
            <details className="capability-assessments">
              <summary>Inspect the planner’s candidate assessment</summary>
              {run.plan.assessments.map((assessment) => (
                <div key={assessment.body_id}>
                  <h3>{bodyName(assessment.body_id, run)}</h3>
                  <p>
                    {assessment.eligible
                      ? 'Ready at a known place in this planning snapshot; segment capabilities are checked separately.'
                      : 'Excluded from this planning snapshot.'}
                  </p>
                  {assessment.reasons.map((reason) => (
                    <p key={reason}>{reason}</p>
                  ))}
                  {assessment.capability_gaps.map((gap) => (
                    <p key={gap.segment_id}>
                      Missing {gap.missing_capabilities.join(', ')} for{' '}
                      {gap.segment_id.replaceAll('_', ' ')}.
                    </p>
                  ))}
                </div>
              ))}
            </details>
            <p className="scope-note">
              This is an executed simulation recording. Declared capabilities alone do not establish
              locomotion; the next chapter shows measured poses and the final chapter states the
              controller’s limits.
            </p>
            <button type="button" className="visitor-button primary" onClick={() => go(1)}>
              Watch the capability transfer →
            </button>
          </>
        )}
        {chapter === 1 && (
          <>
            {video && (
              <figure className="capability-video">
                <video
                  controls
                  muted
                  playsInline
                  preload="none"
                  poster={`${import.meta.env.BASE_URL}demo/${video.video.poster}`}
                  width={video.video.width}
                  height={video.video.height}
                  aria-label="Recorded MuJoCo Go1 joint-state replay from this mission"
                >
                  <source
                    src={`${import.meta.env.BASE_URL}demo/capability-quadruped.mp4`}
                    type="video/mp4"
                  />
                </video>
                <figcaption>
                  <strong>See the measured Go1 climb</strong>
                  <p>
                    External-camera replay of Go1 joint states recorded during this mission. Gazebo
                    and MuJoCo use separate physics worlds. The {video.video.duration_s.toFixed(1)}{' '}
                    s clip has its own player; the timeline below covers the full objective and
                    final standing interval.
                  </p>
                  <a
                    href={`${import.meta.env.BASE_URL}demo/capability-quadruped.provenance.json`}
                    download
                  >
                    Joint-state source, controller and video hashes →
                  </a>
                </figcaption>
              </figure>
            )}
            <div className="replay-caption">
              <p>Recorded positions in the common semantic map frame</p>
              <span>{run.outcome}</span>
            </div>
            <CapabilityMap run={run} time={time} />
            <div className="handoff-legend">
              <span>
                <i className="body-a-dot" />
                Gazebo rover · ground-floor route
              </span>
              <span>
                <i className="body-b-dot" />
                MuJoCo Go1 · stair route
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
                {playing ? 'Pause capability replay' : 'Play capability replay'}
              </button>
              <label>
                Capability replay time
                <output>
                  {fmt(time)} / {fmt(run.duration_s)}
                </output>
                <input
                  type="range"
                  min="0"
                  max={run.duration_s}
                  step="0.001"
                  value={time}
                  aria-label="Capability replay time"
                  onChange={(entry) => {
                    setPlaying(false);
                    setTime(Number(entry.target.value));
                  }}
                />
              </label>
              <label>
                Playback speed
                <select
                  aria-label="Capability replay speed"
                  value={speed}
                  onChange={(entry) => setSpeed(Number(entry.target.value))}
                >
                  {[1, 2, 4, 8].map((value) => (
                    <option key={value} value={value}>
                      {value}×
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="current-event" aria-live="polite">
              <span>{fmt(event?.t ?? 0)}</span>
              <h3>{event?.title ?? 'Route recording ready'}</h3>
              <p>{event?.detail ?? 'Choose an event or play the recorded route.'}</p>
            </div>
            <div className="event-track">
              {timeline.map((entry) => (
                <button
                  type="button"
                  key={`${entry.t}-${entry.title}`}
                  className={entry.t <= time ? 'reached' : ''}
                  onClick={() => {
                    setTime(entry.t);
                    setPlaying(false);
                  }}
                >
                  <time>{fmt(entry.t)}</time>
                  {entry.title}
                </button>
              ))}
            </div>
            <p className="scope-note">
              Approval and context-acknowledgement markers use the core’s recorded timestamps. Other
              events show when the recorder observed their state; polling order does not establish
              actuation order. The final standing interval remains in the replay.
            </p>
            <ElevationProfile run={run} time={time} />
            <div className="callout">
              <strong>Measured telemetry, separate physics worlds</strong>
              <p>
                The rover runs in Gazebo; Go1 runs in MuJoCo. Both report positions in the
                configured semantic frame. This replay combines their telemetry; it does not
                demonstrate collisions between bodies in one physics world. Paths and elevation come
                from the adapters, not an animated route script.
              </p>
            </div>
            <button type="button" className="visitor-button primary" onClick={() => go(2)}>
              Inspect both cameras →
            </button>
          </>
        )}
        {chapter === 2 && (
          <>
            <p className="chapter-lead">The second body starts with the first body’s evidence.</p>
            <p>
              The rover’s accepted observation remains in shared memory through the transfer. The
              receiving agent verifies retained image hashes and acknowledges the reviewed context
              before its stair mission can proceed. Its upper-station image becomes a new
              observation with separate provenance.
            </p>
            <div className="camera-grid">
              {run.observations.map((observation) => (
                <figure key={observation.id}>
                  <div className="camera-label">
                    <span className={observation.outcome === 'detected' ? 'success' : 'anomaly'}>
                      {observation.outcome === 'detected'
                        ? 'Marker detected'
                        : 'No supported marker'}
                    </span>
                    <span>{bodyName(observation.body_id, run)}</span>
                  </div>
                  <img
                    src={`${import.meta.env.BASE_URL}demo/${observation.image}`}
                    width={320}
                    height={240}
                    alt={`Actual ${bodyName(observation.body_id, run)} simulator camera at ${observation.location.replaceAll('_', ' ')}`}
                  />
                  <figcaption>
                    <h3>{placeName(observation.location)}</h3>
                    <p>
                      {observation.confidence == null
                        ? 'No detection score. This image does not establish absence across the whole station.'
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
                      <summary>Image and observation provenance</summary>
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
                      <p>
                        Model: <code>{observation.model_id}</code>
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
              <strong>A bounded perception task</strong>
              <p>
                These are original accepted simulator frames. The classifier recognizes synthetic
                warehouse safety markers; its score is not a claim about general scene
                understanding. Scrubbing the replay never generates a new camera image.
              </p>
            </div>
            <button type="button" className="visitor-button primary" onClick={() => go(3)}>
              Review the approval and limits →
            </button>
          </>
        )}
        {chapter === 3 && (
          <>
            <p className="chapter-lead">
              A reviewed route, a separate transfer approval, and a measured climb.
            </p>
            <ol className="brief-steps">
              <li>
                <span className="step-number">1</span>
                <div>
                  <h3>Approve the exact route</h3>
                  <p>
                    The frozen plan binds source, destination, body assignments, map revision and
                    typed traversal geometry. A changed map or stale candidate requires a fresh
                    review.
                  </p>
                </div>
              </li>
              <li>
                <span className="step-number">2</span>
                <div>
                  <h3>Hold at the body change</h3>
                  <p>
                    The rover stops at the permitted transfer point. The target must still be
                    localized, fresh and ready; an operator separately prepares and approves the
                    handoff after the source command window closes.
                  </p>
                </div>
              </li>
              <li>
                <span className="step-number">3</span>
                <div>
                  <h3>Acknowledge retained context</h3>
                  <p>
                    The receiving agent verifies the context and images. Signed commands, persistent
                    sequences and local motion leases remain enforced by the Rust adapter.
                  </p>
                </div>
              </li>
            </ol>
            <div className="recovery-metrics">
              <div>
                <strong>
                  {run.quadruped.step_count}
                  <small> × {(run.quadruped.riser_height_m * 100).toFixed(0)} cm</small>
                </strong>
                <span>Bounded stair geometry in this run</span>
              </div>
              <div>
                <strong>
                  {run.quadruped.contact_steps.length}
                  <small> surfaces</small>
                </strong>
                <span>Stair surfaces with recorded foot contact</span>
              </div>
              <div>
                <strong>
                  {run.quadruped.final_navigation_z_m.toFixed(2)}
                  <small> m</small>
                </strong>
                <span>Final reported navigation-frame elevation</span>
              </div>
            </div>
            <details className="capability-proof">
              <summary>Inspect the recorded approval and locomotion evidence</summary>
              <dl>
                <dt>Planner</dt>
                <dd>{run.plan.planner_id}</dd>
                <dt>Map</dt>
                <dd>
                  {run.plan.map_id} · revision {run.plan.map_revision}
                </dd>
                <dt>Route plan</dt>
                <dd>
                  <code>{run.route_plan_id}</code>
                </dd>
                <dt>Map SHA-256</dt>
                <dd>
                  <code>{run.plan.map_digest}</code>
                </dd>
                <dt>Route proposal SHA-256</dt>
                <dd>
                  <code>{run.digest}</code>
                </dd>
                <dt>Context SHA-256</dt>
                <dd>
                  <code>{run.handoff.context_digest}</code>
                </dd>
                <dt>Source execution window closed</dt>
                <dd>{new Date(run.handoff.not_before_at).toLocaleString()}</dd>
                <dt>Handoff approved</dt>
                <dd>{new Date(run.handoff.approved_at).toLocaleString()}</dd>
                <dt>Context acknowledged</dt>
                <dd>{new Date(run.handoff.context_acknowledged_at).toLocaleString()}</dd>
                <dt>Physics engine and controller</dt>
                <dd>
                  {run.quadruped.engine} · {run.quadruped.controller}
                </dd>
                <dt>Maximum measured tilt</dt>
                <dd>{run.quadruped.max_tilt_rad.toFixed(3)} rad</dd>
                <dt>Maximum measured motor torque</dt>
                <dd>{run.quadruped.max_motor_torque_nm.toFixed(2)} N·m</dd>
                <dt>Final base elevation</dt>
                <dd>{run.quadruped.final_base_z_m.toFixed(3)} m</dd>
                <dt>Loaded feet at completion</dt>
                <dd>
                  {run.quadruped.foot_contacts_at_completion
                    .map(
                      (contact) =>
                        `${contact.foot}: ${contact.normal_force_n.toFixed(1)} N on ${contact.surfaces.join(', ')}`,
                    )
                    .join('; ')}
                </dd>
              </dl>
            </details>
            <div className="callout">
              <strong>What this run establishes</strong>
              <p>
                One objective continues from a wheeled rover to a Go1 quadruped selected for its
                route capabilities, retaining inspection memory and separate operator approval.
                MuJoCo executes the bounded stairs with a pretrained third-party Walk These Ways
                controller. This does not establish ordinary full-height stair climbing,
                shared-world collision handling, arbitrary terrain navigation, or physical-robot
                reliability.
              </p>
              <p>
                <a href="https://github.com/0vertrained/Lattice/blob/main/simulation/quadruped/THIRD_PARTY.md">
                  Controller attribution and scope →
                </a>
              </p>
            </div>
            <a className="visitor-button" href={artifact} download>
              Download the recorded evidence →
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
            {chapter === 3 ? 'Back to capability decision' : `Next: ${chapters[chapter + 1]}`} →
          </button>
        </div>
      </div>
    </section>
  );
}

export function CapabilityMap({
  run,
  time,
}: {
  readonly run: Pick<CapabilityRecording, 'map' | 'poses' | 'handoff' | 'duration_s'>;
  readonly time: number;
}) {
  const all = [...run.map.places.map((place) => place.pose), ...run.poses];
  const minX = Math.min(...all.map((pose) => pose.x)),
    maxX = Math.max(...all.map((pose) => pose.x));
  const minY = Math.min(...all.map((pose) => pose.y)),
    maxY = Math.max(...all.map((pose) => pose.y));
  const xy = (pose: { x: number; y: number }) => ({
    x: 90 + ((pose.x - minX) / Math.max(1, maxX - minX)) * 560,
    y: 350 - ((pose.y - minY) / Math.max(1, maxY - minY)) * 260,
  });
  const points = (poses: { x: number; y: number }[]) =>
    poses
      .map((pose) => {
        const p = xy(pose);
        return `${p.x},${p.y}`;
      })
      .join(' ');
  return (
    <svg
      className="warehouse-map"
      viewBox="0 0 740 440"
      role="img"
      aria-label="Recorded rover and quadruped paths in the common semantic frame"
    >
      <rect x="30" y="28" width="680" height="384" className="warehouse-floor" />
      {run.map.segments.map((segment) => {
        const from = run.map.places.find((place) => place.id === segment.from),
          to = run.map.places.find((place) => place.id === segment.to);
        if (!from || !to) return null;
        const a = xy(from.pose),
          b = xy(to.pose);
        return (
          <line
            key={segment.id}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            className="capability-planned-edge"
          >
            <title>{segment.required_capabilities.join(', ')} required · semantic segment</title>
          </line>
        );
      })}
      {run.map.places.map((place) => {
        const p = xy(place.pose);
        return (
          <g key={place.id} transform={`translate(${p.x},${p.y})`}>
            <circle r={place.transfer_allowed ? 16 : 10} className="map-station" />
            <text
              y="-25"
              textAnchor={p.x < 180 ? 'start' : p.x > 560 ? 'end' : 'middle'}
              className="map-label"
            >
              {place.label}
            </text>
            <text
              y="-10"
              textAnchor={p.x < 180 ? 'start' : p.x > 560 ? 'end' : 'middle'}
              className="map-label"
            >
              Map elevation {place.pose.z.toFixed(2)} m
            </text>
          </g>
        );
      })}
      {[run.handoff.source_body_id, run.handoff.target_body_id].map((id, index) => {
        const poses = run.poses.filter((pose) => pose.body_id === id);
        const visible = poses.filter((pose) => pose.t <= time);
        const current = visible.at(-1);
        const color = index ? 'var(--body)' : 'var(--ink)';
        return (
          <g key={id}>
            <polyline points={points(poses)} className="route-full" />
            <polyline points={points(visible)} className="route-played" style={{ stroke: color }} />
            {current && (
              <g transform={`translate(${xy(current).x},${xy(current).y})`}>
                <circle r="20" className="rover-halo" />
                <g transform={`rotate(${(-current.yaw * 180) / Math.PI})`}>
                  <circle r="9" className="map-rover" style={{ fill: color }} />
                  <path d="M0 -5L19 0L0 5" className="rover-arrow" style={{ fill: color }} />
                </g>
                <text
                  y="32"
                  textAnchor={xy(current).x > 560 ? 'end' : 'middle'}
                  className="map-label"
                  style={{ fill: color }}
                >
                  {bodyName(id, run)}
                </text>
              </g>
            )}
          </g>
        );
      })}
      <text x="47" y="395" className="map-label">
        Dashed paths: full recording · solid paths: elapsed telemetry · faint lines: planned
        segments
      </text>
    </svg>
  );
}

export function ElevationProfile({
  run,
  time,
}: {
  readonly run: Pick<CapabilityRecording, 'poses' | 'handoff' | 'duration_s'>;
  readonly time: number;
}) {
  const poses = run.poses.filter(
    (pose): pose is typeof pose & { z: number } =>
      pose.body_id === run.handoff.target_body_id && typeof pose.z === 'number',
  );
  if (!poses.length)
    return <p className="scope-note">Elevation telemetry is unavailable in this recording.</p>;
  const minZ = Math.min(0, ...poses.map((pose) => pose.z)),
    maxZ = Math.max(0.2, ...poses.map((pose) => pose.z));
  const xy = (pose: (typeof poses)[number]) =>
    `${70 + (pose.t / run.duration_s) * 600},${115 - ((pose.z - minZ) / (maxZ - minZ)) * 80}`;
  const current = poses.findLast((pose) => pose.t <= time);
  return (
    <figure className="capability-elevation">
      <figcaption>
        Go1 reported map elevation ·{' '}
        {current
          ? `${current.z.toFixed(3)} m at ${fmt(current.t)}`
          : 'awaiting first recorded sample'}
      </figcaption>
      <svg
        viewBox="0 0 740 155"
        role="img"
        aria-label="Measured quadruped map-frame elevation over the recording"
      >
        <line x1="70" y1="115" x2="670" y2="115" className="capability-planned-edge" />
        <text x="58" y="38" textAnchor="end" className="map-label">
          {maxZ.toFixed(2)} m
        </text>
        <text x="58" y="119" textAnchor="end" className="map-label">
          {minZ.toFixed(2)} m
        </text>
        <text x="70" y="140" className="map-label">
          0:00
        </text>
        <text x="670" y="140" textAnchor="end" className="map-label">
          {fmt(run.duration_s)}
        </text>
        <polyline points={poses.map(xy).join(' ')} className="route-full" />
        <polyline
          points={poses
            .filter((pose) => pose.t <= time)
            .map(xy)
            .join(' ')}
          className="route-played"
          style={{ stroke: 'var(--body)' }}
        />
      </svg>
    </figure>
  );
}
