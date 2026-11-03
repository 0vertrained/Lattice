import './stories.css';
import { useEffect, useMemo, useState } from 'react';
import {
  type AdaptiveRecording,
  type AdaptiveScan,
  type AdaptiveVideo,
  adaptiveScanSchema,
  adaptiveVideoSchema,
} from './adaptiveTypes';
import { ChapterShell, type Opened, useChapters } from './chapters/ChapterShell';
import { ElevationProfile } from './chapters/ElevationProfile';
import { EvidencePlate } from './chapters/EvidencePlate';
import { PolarScan } from './chapters/PolarScan';
import { bodyReadouts, ReplayPanel } from './chapters/ReplayPanel';
import { speeds } from './chapters/ReplayTrace';
import { Capabilities, RouteSheet, TitleBlock } from './chapters/RouteSheet';
import { LatticeDrawing } from './drawing/LatticeDrawing';
import { adaptiveScene, routeScene } from './drawing/scenes';

const chapters = [
  'A new route condition',
  'Reviewed continuity',
  'Measured continuation',
  'Evidence and limits',
] as const;
const name = (id: string, run: AdaptiveRecording) =>
  id === run.handoff.source_body_id
    ? 'Gazebo rover'
    : id === run.handoff.target_body_id
      ? 'MuJoCo Go1'
      : id;
const asset = (file: string) => `${import.meta.env.BASE_URL}demo/${file}`;

const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString() : 'Not recorded';

/** The blockage scan, used only when its bytes match the hash bound into the authenticated condition. */
function useVerifiedScan(run: AdaptiveRecording) {
  const [scan, setScan] = useState<AdaptiveScan | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    setScan(null);
    setError('');
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
      .catch((reason) => {
        if (!abort.signal.aborted)
          setError(reason instanceof Error ? reason.message : 'Unable to verify the scan.');
      });
    return () => abort.abort();
  }, [run.lidar_scan]);
  return { scan, error };
}

/** The same-run Go1 physics replay, when its provenance names this round and map. */
function useVideo(run: AdaptiveRecording) {
  const [video, setVideo] = useState<AdaptiveVideo | null>(null);
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
  return video;
}

export default function AdaptiveStory({
  run,
  opened,
}: {
  readonly run: AdaptiveRecording;
  readonly opened: Opened | null;
}) {
  const { chapter, go, heading } = useChapters(opened);
  const [stage, setStage] = useState<'original' | 'detour'>('original');
  const { scan, error } = useVerifiedScan(run);
  const video = useVideo(run);
  const condition = run.condition_observation;
  const evidence = condition.evidence;
  // A place's short name: its map label before any description, such as "Stair transfer".
  const placeName = (id: string) => {
    const label = run.map.places.find((place) => place.id === id)?.label;
    return label?.split(' · ')[0] ?? id.replaceAll('_', ' ');
  };
  const blocked = run.map.segments.find(
    (segment) => segment.id === run.adaptation.blocked_segment_id,
  );
  const target = run.map.places.find((place) => place.id === blocked?.to)?.pose;
  const retained = run.observations.filter((observation) =>
    run.replan.retained_observation_ids.includes(observation.id),
  );
  const scene = useMemo(() => adaptiveScene(run, scan), [run, scan]);
  const route = useMemo(() => routeScene(scene, stage), [scene, stage]);
  const series = useMemo(() => scene.tracks.map((track) => speeds(track.samples)), [scene]);
  const elevation = useMemo(
    () =>
      run.poses.flatMap((pose) =>
        pose.body_id === run.handoff.target_body_id && typeof pose.z === 'number'
          ? [{ t: pose.t, z: pose.z }]
          : [],
      ),
    [run],
  );
  // Condition receipt, review creation, approvals and acknowledgement use their stored timestamps.
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
  return (
    <ChapterShell
      label="Adaptive route walkthrough"
      className="capability-story adaptive-story"
      navLabel="Adaptive route chapters"
      chapters={chapters}
      chapter={chapter}
      go={go}
      heading={heading}
      back="Back to the new condition"
      facts={
        <>
          <span>Recorded {new Date(run.recorded_at).toLocaleDateString()}</span>
          <span>{run.mission_duration_s.toFixed(1)} s objective completed</span>
          <span>{run.duration_s.toFixed(1)} s recorded, including the standing interval</span>
          <a href={asset('adaptive-route.json')} download>
            Download the adaptive run
          </a>
        </>
      }
    >
      {chapter === 0 && (
        <>
          <p className="chapter-lead">The aisle is blocked. The inspection still counts.</p>
          <p>
            The rover completes its bay inspection, then reports lidar returns blocking the reviewed
            direct segment. Its local controller stops, and Lattice holds the same objective. The
            remaining route can change without repeating the completed inspection or discarding its
            camera evidence.
          </p>
          {scan && evidence && target ? (
            <PolarScan
              scan={scan}
              base={evidence.observer_pose}
              target={target}
              targetLabel={placeName(blocked?.to ?? '')}
              hits={evidence.blocked_samples}
              nearest={evidence.distance_m}
            />
          ) : (
            !error && (
              <p role="status" className="scope-note">
                Verifying the original lidar scan before drawing its returns…
              </p>
            )
          )}
          {error && (
            <p className="visitor-error" role="alert">
              {error} The route diagram remains available without a scan overlay.
            </p>
          )}
          {scan && (
            <p className="scope-note">
              Original scan hash verified: {scan.ranges.length} samples in the{' '}
              {scan.sensor_frame_id} frame, placed with the sensor transform recorded at
              acquisition.
            </p>
          )}
          <dl className="readouts">
            <div>
              <dt>Nearest corridor return</dt>
              <dd>{evidence ? `${evidence.distance_m.toFixed(2)} m` : 'Not recorded'}</dd>
            </div>
            <div>
              <dt>Returns supporting the block</dt>
              <dd>{evidence?.blocked_samples ?? 'Not recorded'}</dd>
            </div>
            <div>
              <dt>Condition revision under review</dt>
              <dd>{run.replan.conditions_revision}</dd>
            </div>
            <div>
              <dt>Inspections repeated</dt>
              <dd>{run.adaptation.repeated_inspections}</dd>
            </div>
          </dl>
          <h3 className="section-title">The route, before and after the review</h3>
          <fieldset className="segmented" aria-label="Adaptive route comparison">
            <button
              type="button"
              aria-pressed={stage === 'original'}
              onClick={() => setStage('original')}
            >
              Original route
            </button>
            <button
              type="button"
              aria-pressed={stage === 'detour'}
              onClick={() => setStage('detour')}
            >
              Reviewed detour
            </button>
          </fieldset>
          <div className="plate replay-plate">
            <LatticeDrawing
              key={stage}
              scene={route}
              mode="replay"
              label={
                stage === 'original'
                  ? 'Original route with measured blockage scan returns'
                  : 'Reviewed detour with measured blockage scan returns'
              }
            />
          </div>
          <section className="limits" aria-labelledby="laser-title">
            <h3 id="laser-title">What the laser observation establishes</h3>
            <p>{condition.reason}</p>
            <p>
              The evaluator inserted a collision-enabled box into Gazebo after staging, outside the
              static occupancy map. The robot reported a blocked path from its real simulated lidar;
              it did not classify the object as a box. The scan remains available independently of
              these drawings.
            </p>
            <a href={asset(run.lidar_scan.file)} download>
              Download the original scan
            </a>
          </section>
        </>
      )}
      {chapter === 1 && (
        <>
          <p className="chapter-lead">A new remainder. The same objective.</p>
          <p>
            The original destination remains {placeName(run.objective.route.destination_place_id)}.
            The planner excludes the blocked segment and proposes the west bypass. An operator
            reviews the exact remaining steps while the original source authorization expires;
            approval also requires fresh source telemetry after that stop fence.
          </p>
          <div className="sheet-layout">
            <RouteSheet
              caption="Revised remainder, same round"
              columns={['Step', 'Operation', 'Assigned to']}
              steps={[
                ...run.replan.completed_steps.map((step) => ({
                  title: step.title,
                  done: true,
                  detail: 'Completed before the blockage; its observation is kept',
                })),
                ...run.replan.remaining_steps.map((step, index) => ({
                  title: step.title.replaceAll('_', ' '),
                  detail: (
                    <>
                      <strong>{name(run.replan.step_body_ids[index] ?? '', run)}</strong>
                      {step.command.type === 'traverse_route' ? (
                        <Capabilities list={step.command.traversal.required_capabilities} />
                      ) : (
                        'Captures a new accepted inspection'
                      )}
                    </>
                  ),
                  ...(run.replan.step_body_ids[index] === run.handoff.target_body_id &&
                  run.replan.step_body_ids[index - 1] !== run.handoff.target_body_id
                    ? { note: 1 }
                    : {}),
                })),
              ]}
              block={[
                ['Round', <code key="r">{run.round_id}</code>],
                ['Replacement review, SHA-256', <code key="d">{run.replan.digest}</code>, 'wide'],
              ]}
              notes={[
                <>
                  <strong>The capability transfer is a separate decision.</strong> After the rover
                  finishes the detour, Go1 receives its own reviewed handoff at the stair landing.
                  Retained image hashes and context are verified before it continues. Approving a
                  replacement route never approves that transfer.
                </>,
              ]}
            />
            {retained.map((observation) => (
              <EvidencePlate
                key={observation.id}
                src={asset(observation.image)}
                alt="Original bay inspection retained across the route replan"
                title={`${placeName(observation.location)}, retained`}
                status={
                  observation.outcome === 'detected' ? 'Marker detected' : 'No supported marker'
                }
                found={observation.outcome === 'detected'}
                box={observation.detections[0]?.box}
                label={name(observation.body_id, run)}
                block={[
                  ['Captured', when(observation.captured_at)],
                  ['Observation', <code key="o">{observation.id}</code>],
                  ['Image SHA-256', <code key="h">{observation.image_sha256}</code>, 'wide'],
                ]}
              >
                <p>
                  Accepted before the blocked segment and kept through the detour and the later body
                  transfer.
                </p>
                <a href={asset(observation.image)} download>
                  Original JPEG
                </a>
              </EvidencePlate>
            ))}
          </div>
          <details>
            <summary>Inspect the preserved objective and new review binding</summary>
            <dl>
              <dt>Previous round SHA-256</dt>
              <dd>
                <code>{run.replan.round_digest}</code>
              </dd>
              <dt>Source authorization fence ended</dt>
              <dd>{when(run.replan.not_before_at)}</dd>
              <dt>Replacement approved</dt>
              <dd>{when(run.replan.approved_at)}</dd>
              <dt>Review expiry</dt>
              <dd>{when(run.replan.expires_at)}</dd>
              <dt>Retained observation identities</dt>
              <dd>
                <code>{run.replan.retained_observation_ids.join(', ')}</code>
              </dd>
            </dl>
          </details>
        </>
      )}
      {chapter === 2 && (
        <>
          <ReplayPanel
            caption="Measured adapter poses, original objective retained"
            scene={scene}
            label="Recorded paths of the Gazebo rover on the reviewed detour and the MuJoCo Go1 on the stairs"
            duration={run.duration_s}
            events={timeline}
            series={series}
            name="Adaptive replay time"
            play="Play adaptive replay"
            pause="Pause adaptive replay"
            eventsLabel="Jump to an adaptive event"
            speeds={[1, 2, 4, 8]}
            initialSpeed={4}
            idle={{
              title: 'Adaptive recording ready',
              detail: 'Play the recording or choose a recorded event.',
            }}
            readouts={(time) => bodyReadouts(scene, time)}
          >
            {(time) => (
              <ElevationProfile
                samples={elevation}
                body="Go1"
                duration={run.duration_s}
                time={time}
              />
            )}
          </ReplayPanel>
          {video && (
            <figure className="plate capability-video">
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
                The {video.video.duration_s.toFixed(1)} s clip has its own player; the replay above
                covers the whole objective.{' '}
                <a href={asset('adaptive-quadruped.provenance.json')} download>
                  Replay provenance
                </a>
              </figcaption>
            </figure>
          )}
          <p className="scope-note">
            Condition receipt, review creation, approval and context acknowledgement use their
            stored timestamps. Mission events show when polling observed them; polling order does
            not establish actuation order. The final standing interval is included.
          </p>
        </>
      )}
      {chapter === 3 && (
        <>
          <p className="chapter-lead">Inspect the evidence behind the outcome.</p>
          <div className="camera-grid">
            {run.observations.map((observation) => (
              <EvidencePlate
                key={observation.id}
                src={asset(observation.image)}
                alt={`Accepted ${name(observation.body_id, run)} camera at ${observation.location.replaceAll('_', ' ')}`}
                title={placeName(observation.location)}
                status={
                  observation.outcome === 'detected' ? 'Marker detected' : 'No supported marker'
                }
                found={observation.outcome === 'detected'}
                box={observation.detections[0]?.box}
                label={name(observation.body_id, run)}
                block={[
                  ['Captured', when(observation.captured_at)],
                  [
                    'Detector score',
                    observation.confidence == null
                      ? 'No supported score'
                      : `${(observation.confidence * 100).toFixed(1)}%`,
                  ],
                  ['Model', <code key="m">{observation.model_id}</code>],
                ]}
              >
                <p className="scope-note">{observation.confidence_domain}</p>
                <details>
                  <summary>Adaptive inspection provenance</summary>
                  <p>
                    Observation <code>{observation.id}</code>
                  </p>
                  <p>
                    Mission <code>{observation.mission_id}</code>
                  </p>
                  <code>JPEG SHA-256: {observation.image_sha256}</code>
                  <code>Frame SHA-256: {observation.frame_sha256}</code>
                </details>
                <a href={asset(observation.image)} download>
                  Original recorded image
                </a>
              </EvidencePlate>
            ))}
          </div>
          <dl className="readouts">
            <div>
              <dt>Replan prepared in</dt>
              <dd>{run.adaptation.replan_proposal_ms.toFixed(1)} ms</dd>
            </div>
            <div>
              <dt>Held until approval</dt>
              <dd>{run.adaptation.hold_to_approval_s.toFixed(1)} s</dd>
            </div>
            <div>
              <dt>Source drift while held</dt>
              <dd>{(run.adaptation.source_drift_while_held_m * 100).toFixed(2)} cm</dd>
            </div>
            <div>
              <dt>Stair geometry</dt>
              <dd>
                {run.quadruped.step_count} × {(run.quadruped.riser_height_m * 100).toFixed(0)} cm
              </dd>
            </div>
          </dl>
          <p className="scope-note">
            Replan time covers the prepare-review request, including transport and persistence. The
            hold runs from the observed stop to explicit approval and includes the source fence.
          </p>
          <details>
            <summary>Inspect scan, context and route provenance</summary>
            <TitleBlock
              cells={[
                ['Authenticated condition', <code key="c">{condition.id}</code>],
                ['Bound source command', <code key="b">{condition.command_id}</code>],
                ['Scan observed', when(condition.observed_at)],
                ['Scan SHA-256', <code key="s">{run.lidar_scan.sha256}</code>, 'wide'],
                ['Final round SHA-256', <code key="f">{run.digest}</code>, 'wide'],
                [
                  'Shared handoff context SHA-256',
                  <code key="x">{run.handoff.context_digest}</code>,
                  'wide',
                ],
                ['Controller', `${run.quadruped.controller}, ${run.quadruped.engine}`],
                ['Measured step contacts', run.quadruped.contact_steps.join(', ')],
              ]}
            />
            <a href={asset(run.lidar_scan.file)} download>
              Download the original laser scan
            </a>
          </details>
          <section className="limits" aria-labelledby="adaptive-limits">
            <h3 id="adaptive-limits">What this establishes, and where it stops</h3>
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
              This is bounded simulation evidence, not unrestricted navigation or physical-hardware
              validation.
            </p>
            <p className="link-row">
              <a href="https://github.com/0vertrained/Lattice/blob/main/simulation/quadruped/THIRD_PARTY.md">
                Controller attribution
              </a>
              <a href="https://github.com/0vertrained/Lattice/blob/main/evaluation/adaptive-missions-2026-11-02.json">
                Compare the recorded scenario outcomes and development failure
              </a>
              <a href={asset('adaptive-route.json')} download>
                Download the complete adaptive record
              </a>
            </p>
          </section>
        </>
      )}
    </ChapterShell>
  );
}
