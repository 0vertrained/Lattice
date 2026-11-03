import './stories.css';
import { useEffect, useMemo, useState } from 'react';
import {
  type CapabilityRecording,
  type CapabilityVideo,
  capabilityVideoSchema,
} from './capabilityTypes';
import { ChapterShell, type Opened, useChapters } from './chapters/ChapterShell';
import { ElevationProfile } from './chapters/ElevationProfile';
import { EvidencePlate } from './chapters/EvidencePlate';
import { bodyReadouts, ReplayPanel } from './chapters/ReplayPanel';
import { speeds } from './chapters/ReplayTrace';
import { Capabilities, RouteSheet, TitleBlock } from './chapters/RouteSheet';
import { capabilityScene } from './drawing/scenes';

const chapters = [
  'Capability decision',
  'Measured traversal',
  'Camera continuity',
  'Approval and limits',
] as const;
const bodyName = (id: string, run: Pick<CapabilityRecording, 'handoff'>) =>
  id === run.handoff.source_body_id
    ? 'Gazebo rover'
    : id === run.handoff.target_body_id
      ? 'MuJoCo Go1'
      : id;
const asset = (file: string) => `${import.meta.env.BASE_URL}demo/${file}`;
const when = (iso: string) => new Date(iso).toLocaleString();
const seconds = (value: number) => `${value.toFixed(1)} s`;

/** The same-run Go1 physics replay, when its provenance names this round and map. */
function useVideo(run: CapabilityRecording) {
  const [video, setVideo] = useState<CapabilityVideo | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch(asset('capability-quadruped.provenance.json'), { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        const parsed = capabilityVideoSchema.safeParse(await response.json());
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
  return video;
}

/**
 * Each segment's required capabilities against each candidate body, as the planner assessed them:
 * the body it assigned, other bodies able to take the segment, and the capabilities a body lacks.
 */
function CapabilityMatrix({
  run,
  place,
}: {
  readonly run: CapabilityRecording;
  readonly place: (id: string) => string;
}) {
  const assessments = run.plan.assessments;
  return (
    <div className="plate matrix-plate">
      <table className="matrix">
        <caption>Segment needs against each body, from the planner’s assessment</caption>
        <thead>
          <tr>
            <td />
            {assessments.map((assessment) => (
              <th scope="col" key={assessment.body_id}>
                {bodyName(assessment.body_id, run)}
                <small>Staged at {place(assessment.place_id ?? '')}</small>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {run.map.segments.map((segment) => {
            const leg = run.plan.legs.find((item) => item.segment_id === segment.id);
            return (
              <tr key={segment.id}>
                <th scope="row">
                  {place(segment.from)} to {place(segment.to)}
                  <small>
                    <Capabilities list={segment.required_capabilities} />
                  </small>
                </th>
                {assessments.map((assessment) => {
                  const gap = assessment.capability_gaps.find(
                    (item) => item.segment_id === segment.id,
                  );
                  const state = gap
                    ? 'gap'
                    : leg?.body_id === assessment.body_id
                      ? 'assigned'
                      : assessment.eligible
                        ? 'able'
                        : 'excluded';
                  return (
                    <td key={assessment.body_id} data-state={state}>
                      {state === 'gap' && gap ? (
                        <>
                          Lacks <code>{gap.missing_capabilities.join(', ')}</code>
                        </>
                      ) : state === 'assigned' ? (
                        'Assigned'
                      ) : state === 'able' ? (
                        'Able'
                      ) : (
                        'Excluded'
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function CapabilityStory({
  run,
  opened,
}: {
  readonly run: CapabilityRecording;
  readonly opened: Opened | null;
}) {
  const { chapter, go, heading } = useChapters(opened);
  const video = useVideo(run);
  const scene = useMemo(() => capabilityScene(run), [run]);
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
  const since = (iso: string) =>
    Math.max(0, (Date.parse(iso) - Date.parse(run.recorded_at)) / 1000);
  // Approval and context acknowledgement use the core's stored timestamps.
  const timeline = useMemo(() => {
    const start = Date.parse(run.recorded_at);
    return run.events
      .map((entry) => {
        const timestamp =
          entry.kind === 'memory'
            ? run.handoff.context_acknowledged_at
            : entry.kind === 'approval' && entry.title === 'Go1 continuation approved'
              ? run.handoff.approved_at
              : null;
        return timestamp
          ? { ...entry, t: Math.max(0, (Date.parse(timestamp) - start) / 1000) }
          : entry;
      })
      .sort((a, b) => a.t - b.t);
  }, [run]);
  const completedAt = run.events.find((entry) => entry.kind === 'complete')?.t;
  const approvedAt = run.events.find((entry) => entry.kind === 'approval')?.t;
  const heldAt = run.events.find((entry) => entry.kind === 'handoff')?.t;
  const place = (id: string) => {
    const label = run.map.places.find((item) => item.id === id)?.label;
    return label?.split(' · ')[0] ?? id.replaceAll('_', ' ');
  };
  return (
    <ChapterShell
      label="Capability route walkthrough"
      className="capability-story"
      navLabel="Capability route chapters"
      chapters={chapters}
      chapter={chapter}
      go={go}
      heading={heading}
      back="Back to capability decision"
      facts={
        <>
          <span>Recorded {new Date(run.recorded_at).toLocaleDateString()}</span>
          <span>
            {completedAt !== undefined
              ? `${completedAt.toFixed(1)} s objective completed`
              : run.outcome}
          </span>
          <span>{run.duration_s.toFixed(1)} s recorded, including the final standing interval</span>
          <a href={asset('capability-route.json')} download>
            Download the capability run
          </a>
        </>
      }
    >
      {chapter === 0 && (
        <>
          <p className="chapter-lead">The route needs stairs. The rover needs another body.</p>
          <p>
            A rover inspects the ground-floor bay and reaches a transfer point. The deterministic
            planner assigns the next segment to a staged Go1 with stairs capability. An operator
            reviews the route, then approves the actual transfer after the rover stops and the
            receiving body is checked again.
          </p>
          <CapabilityMatrix run={run} place={place} />
          {run.plan.transfers.map((transfer) => (
            <section
              className="limits"
              key={`${transfer.place_id}-${transfer.target_body_id}`}
              aria-labelledby={`transfer-${transfer.place_id}`}
            >
              <h3 id={`transfer-${transfer.place_id}`}>
                Why the body changes at {place(transfer.place_id)}
              </h3>
              <p>{transfer.reason}</p>
              <p>
                The replacement was already staged at this permitted transfer point. Planning did
                not send it there automatically.
              </p>
            </section>
          ))}
          <RouteSheet
            caption="Reviewed route, one objective"
            columns={['Step', 'Operation', 'Assigned to']}
            steps={run.steps.map((step, index) => ({
              title: step.title,
              detail: (
                <>
                  <strong>{bodyName(run.step_body_ids[index] ?? '', run)}</strong>
                  {step.command.type === 'traverse_route' ? (
                    <Capabilities list={step.command.traversal.required_capabilities} />
                  ) : (
                    'Keeps the accepted camera evidence'
                  )}
                </>
              ),
            }))}
            block={[
              ['Round', <code key="r">{run.round_id}</code>],
              ['Route plan', <code key="p">{run.route_plan_id}</code>],
              [
                'Stairs in this run',
                `${run.quadruped.step_count} risers of ${(run.quadruped.riser_height_m * 100).toFixed(0)} cm`,
              ],
            ]}
          />
          <details>
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
            controller’s limits. Go1 climbs with the pretrained Walk These Ways controller in
            MuJoCo.
          </p>
        </>
      )}
      {chapter === 1 && (
        <>
          <ReplayPanel
            caption="Recorded positions in the common semantic map frame"
            scene={scene}
            label="Recorded rover and quadruped paths in the common semantic frame"
            duration={run.duration_s}
            events={timeline}
            series={series}
            name="Capability replay time"
            play="Play capability replay"
            pause="Pause capability replay"
            eventsLabel="Jump to a capability event"
            speeds={[1, 2, 4, 8]}
            initialSpeed={4}
            idle={{
              title: 'Route recording ready',
              detail: 'Choose an event or play the recorded route.',
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
                aria-label="Recorded MuJoCo Go1 joint-state replay from this mission"
              >
                <source src={asset('capability-quadruped.mp4')} type="video/mp4" />
              </video>
              <figcaption>
                External-camera replay of Go1 joint states recorded during this mission. The{' '}
                {video.video.duration_s.toFixed(1)} s clip has its own player; the replay above
                covers the full objective and the final standing interval.{' '}
                <a href={asset('capability-quadruped.provenance.json')} download>
                  Joint-state source, controller and video hashes
                </a>
              </figcaption>
            </figure>
          )}
          <p className="scope-note">
            Approval and context-acknowledgement markers use the core’s recorded timestamps. Other
            events show when the recorder observed their state; polling order does not establish
            actuation order. The final standing interval remains in the replay.
          </p>
          <section className="limits" aria-labelledby="worlds-title">
            <h3 id="worlds-title">Measured telemetry, separate physics worlds</h3>
            <p>
              The rover runs in Gazebo; Go1 runs in MuJoCo. Both report positions in the configured
              semantic frame. This replay combines their telemetry; it does not demonstrate
              collisions between bodies in one physics world. Paths and elevation come from the
              adapters, not an animated route script.
            </p>
          </section>
        </>
      )}
      {chapter === 2 && (
        <>
          <p className="chapter-lead">The second body starts with the first body’s evidence.</p>
          <p>
            The rover’s accepted observation remains in shared memory through the transfer. The
            receiving agent verifies retained image hashes and acknowledges the reviewed context
            before its stair mission can proceed. Its upper-station image becomes a new observation
            with separate provenance.
          </p>
          <div className="camera-grid">
            {run.observations.map((observation) => (
              <EvidencePlate
                key={observation.id}
                src={asset(observation.image)}
                alt={`Actual ${bodyName(observation.body_id, run)} simulator camera at ${observation.location.replaceAll('_', ' ')}`}
                title={place(observation.location)}
                status={
                  observation.outcome === 'detected' ? 'Marker detected' : 'No supported marker'
                }
                found={observation.outcome === 'detected'}
                box={observation.detections[0]?.box}
                label={bodyName(observation.body_id, run)}
                block={[
                  ['Captured', when(observation.captured_at)],
                  [
                    'Detector score',
                    observation.confidence == null
                      ? 'No detection score'
                      : `${(observation.confidence * 100).toFixed(1)}%`,
                  ],
                  ['Model', <code key="m">{observation.model_id}</code>],
                ]}
              >
                {observation.confidence == null && (
                  <p>This image does not establish absence across the whole station.</p>
                )}
                <p className="scope-note">{observation.confidence_domain}</p>
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
                  <code>JPEG SHA-256: {observation.image_sha256}</code>
                  <code>Frame SHA-256: {observation.frame_sha256}</code>
                </details>
                <a href={asset(observation.image)} download>
                  Original recorded image
                </a>
              </EvidencePlate>
            ))}
          </div>
          <section className="limits" aria-labelledby="perception-title">
            <h3 id="perception-title">A bounded perception task</h3>
            <p>
              These are original accepted simulator frames. The classifier recognizes synthetic
              warehouse safety markers; its score is not a claim about general scene understanding.
              Scrubbing the replay never generates a new camera image.
            </p>
          </section>
        </>
      )}
      {chapter === 3 && (
        <>
          <p className="chapter-lead">
            A reviewed route, a separate transfer approval, and a measured climb.
          </p>
          <RouteSheet
            caption="Transfer record"
            columns={['Step', 'Check', 'Recorded']}
            steps={[
              {
                title: 'Approve the exact route',
                text: 'The frozen plan binds source, destination, body assignments, map revision and typed traversal geometry. A changed map or stale candidate requires a fresh review.',
                detail:
                  approvedAt === undefined ? 'Not recorded' : `Approved at ${seconds(approvedAt)}`,
              },
              {
                title: 'Hold at the body change',
                text: 'The rover stops at the permitted transfer point. The target must still be localized, fresh and ready; an operator separately approves the handoff after the source command window closes.',
                detail: (
                  <>
                    {heldAt !== undefined && (
                      <span className="sheet-line">Held for review at {seconds(heldAt)}</span>
                    )}
                    <span className="sheet-line">
                      Source window closed at {seconds(since(run.handoff.not_before_at))}
                    </span>
                    <span className="sheet-line">
                      Handoff approved at {seconds(since(run.handoff.approved_at))}
                    </span>
                  </>
                ),
              },
              {
                title: 'Acknowledge retained context',
                text: 'The receiving agent verifies the context and images. Signed commands, persistent sequences and local motion leases remain enforced by the Rust adapter.',
                detail: `Acknowledged at ${seconds(since(run.handoff.context_acknowledged_at))}`,
              },
            ]}
            block={[
              ['Map', `${run.plan.map_id}, revision ${run.plan.map_revision}`],
              ['Planner', run.plan.planner_id],
              ['Route proposal SHA-256', <code key="d">{run.digest}</code>, 'wide'],
            ]}
          />
          <dl className="readouts">
            <div>
              <dt>Stair geometry</dt>
              <dd>
                {run.quadruped.step_count} × {(run.quadruped.riser_height_m * 100).toFixed(0)} cm
              </dd>
            </div>
            <div>
              <dt>Surfaces with foot contact</dt>
              <dd>{run.quadruped.contact_steps.length}</dd>
            </div>
            <div>
              <dt>Final navigation elevation</dt>
              <dd>{run.quadruped.final_navigation_z_m.toFixed(2)} m</dd>
            </div>
            <div>
              <dt>Maximum measured tilt</dt>
              <dd>{((run.quadruped.max_tilt_rad * 180) / Math.PI).toFixed(1)}°</dd>
            </div>
          </dl>
          <details>
            <summary>Inspect the recorded approval and locomotion evidence</summary>
            <TitleBlock
              cells={[
                ['Map SHA-256', <code key="m">{run.plan.map_digest}</code>, 'wide'],
                ['Context SHA-256', <code key="c">{run.handoff.context_digest}</code>, 'wide'],
                ['Source execution window closed', when(run.handoff.not_before_at)],
                ['Handoff approved', when(run.handoff.approved_at)],
                ['Context acknowledged', when(run.handoff.context_acknowledged_at)],
                [
                  'Physics engine and controller',
                  `${run.quadruped.engine}, ${run.quadruped.controller}`,
                ],
                [
                  'Maximum measured motor torque',
                  `${run.quadruped.max_motor_torque_nm.toFixed(2)} N·m`,
                ],
                ['Final base elevation', `${run.quadruped.final_base_z_m.toFixed(3)} m`],
                [
                  'Loaded feet at completion',
                  run.quadruped.foot_contacts_at_completion
                    .map(
                      (contact) =>
                        `${contact.foot}: ${contact.normal_force_n.toFixed(1)} N on ${contact.surfaces.join(', ')}`,
                    )
                    .join('; '),
                  'wide',
                ],
              ]}
            />
          </details>
          <section className="limits" aria-labelledby="capability-limits">
            <h3 id="capability-limits">What this run establishes</h3>
            <p>
              One objective continues from a wheeled rover to a Go1 quadruped selected for its route
              capabilities, retaining inspection memory and separate operator approval. MuJoCo
              executes the bounded stairs with a pretrained third-party Walk These Ways controller.
              This does not establish ordinary full-height stair climbing, shared-world collision
              handling, arbitrary terrain navigation, or physical-robot reliability.
            </p>
            <p className="link-row">
              <a href="https://github.com/0vertrained/Lattice/blob/main/simulation/quadruped/THIRD_PARTY.md">
                Controller attribution and scope
              </a>
              <a href={asset('capability-route.json')} download>
                Download the recorded evidence
              </a>
            </p>
          </section>
        </>
      )}
    </ChapterShell>
  );
}
