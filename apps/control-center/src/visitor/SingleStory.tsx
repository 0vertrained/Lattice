import { lazy, useEffect, useMemo, useState } from 'react';
import { ChapterShell, type Opened, useChapters } from './chapters/ChapterShell';
import { EvidencePlate } from './chapters/EvidencePlate';
import { Ladder, type Rung } from './chapters/Ladder';
import { ReplayPanel } from './chapters/ReplayPanel';
import { speeds } from './chapters/ReplayTrace';
import { RouteSheet } from './chapters/RouteSheet';
import { Schematic } from './chapters/Schematic';
import { singleScene } from './drawing/scenes';
import { minutes as fmt, signed } from './format';
import type { Walkthrough } from './types';

const RecordedTwin = lazy(() => import('./RecordedTwin'));
const chapters = [
  'Briefing',
  'Recorded mission',
  'Camera evidence',
  'Restart recovery',
  'Architecture',
] as const;
const asset = (file: string) => `${import.meta.env.BASE_URL}demo/${file}`;
const seconds = (value: number, digits = 1) => `${value.toFixed(digits)} s`;

/** The core restart as recorded: each moment's interlock state, in the order the run reached them. */
function recoveryStages(run: Walkthrough) {
  const at = (title: string, detail?: string) =>
    run.events.find((e) => e.title === title && (!detail || e.detail === detail))?.t;
  const interrupted = at('Core interrupted during motion') ?? 0;
  const held = at('Recovery requires review') ?? interrupted;
  const approved = at('Recovery approved') ?? held;
  const resumed = run.events.find((e) => e.t > approved && e.detail === 'running')?.t ?? approved;
  const leg = run.events.findLast((e) => e.t < interrupted && e.detail === 'assigned');
  const completed = at('Round completed') ?? run.duration_s;
  const { stop_observed_after_s: stop, post_stop_drift_m: drift } = run.recovery;
  // Contacts: heartbeat from the same core epoch, verified command, unfinished round, approval.
  const stage = (
    name: string,
    t: number,
    digits: number,
    text: string,
    state: readonly [boolean, boolean, boolean, boolean],
  ) => ({ name, t, digits, text, state });
  return [
    stage(
      'Running',
      leg?.t ?? 0,
      1,
      'The rover is on its return leg. Each authenticated heartbeat from the core that issued its command renews the local motion lease.',
      [true, true, false, false],
    ),
    stage(
      'Fence',
      interrupted,
      1,
      `The core process is killed and a replacement starts with a new epoch. A heartbeat that reaches a different epoch clears the command, and a 1.5 s watchdog drops the lease if heartbeats stop. Motion was observed stopped ${seconds(stop, 2)} after the interruption, with ${(drift * 100).toFixed(1)} cm of drift.`,
      [false, false, false, false],
    ),
    stage(
      'Hold',
      held,
      2,
      'The new core finds the unfinished round and holds it for review. Camera evidence and history survived. No automatic motion resumed.',
      [true, false, true, false],
    ),
    stage(
      'Review',
      approved,
      2,
      'An operator approves a fresh, expiring recovery proposal for the held mission. Reconnection alone cannot restart it. Approval creates a new command identity with a higher sequence.',
      [true, false, true, true],
    ),
    stage(
      'Resume',
      resumed,
      2,
      `The rover verifies the new command’s signature, body, expiry and sequence, and the lease is renewed. The round completes at ${seconds(completed)} with its earlier evidence intact.`,
      [true, true, false, false],
    ),
  ];
}

function RecoveryLadder({ run }: { readonly run: Walkthrough }) {
  const stages = useMemo(() => recoveryStages(run), [run]);
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    if (!playing) return;
    if (at >= stages.length - 1) return setPlaying(false);
    const next = window.setTimeout(() => setAt(at + 1), 1400);
    return () => window.clearTimeout(next);
  }, [playing, at, stages.length]);
  const current = stages[at] ?? stages[0];
  if (!current) return null;
  const [epoch, command, unfinished, approval] = current.state;
  const rungs: Rung[] = [
    {
      name: 'Motion lease',
      contacts: [
        { label: 'Heartbeat from the same core epoch', closed: epoch },
        { label: 'Verified signed command', closed: command },
      ],
      coil: 'Lease renewed; the rover may move',
    },
    {
      name: 'Hold',
      contacts: [{ label: 'Unfinished round from an earlier epoch', closed: unfinished }],
      coil: 'Round held for review',
      hold: true,
    },
    {
      name: 'Review',
      contacts: [
        { label: 'Round held', closed: unfinished },
        { label: 'Operator approves the recovery', closed: approval },
      ],
      coil: 'New command, higher sequence',
    },
  ];
  return (
    <div className="recovery">
      <fieldset className="stages" aria-label="Recorded moments of the restart">
        {stages.map((stage, index) => (
          <button
            type="button"
            key={stage.name}
            aria-pressed={index === at}
            onClick={() => {
              setPlaying(false);
              setAt(index);
            }}
          >
            {stage.name}
            <span className="figures">{seconds(stage.t, stage.digits)}</span>
          </button>
        ))}
      </fieldset>
      <Ladder rungs={rungs} label={`Interlocks at ${current.name.toLowerCase()}`} />
      <div className="stage-note">
        <p aria-live="polite">
          <strong>
            {current.name}, {seconds(current.t, current.digits)}.
          </strong>{' '}
          {current.text}
        </p>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            if (at >= stages.length - 1) setAt(0);
            setPlaying(!playing);
          }}
        >
          {playing ? 'Pause the restart' : 'Play the restart'}
        </button>
      </div>
    </div>
  );
}

export default function SingleStory({
  run,
  source,
  opened,
}: {
  readonly run: Walkthrough;
  readonly source: string;
  readonly opened: Opened | null;
}) {
  const { chapter, go, heading } = useChapters(opened);
  const scene = useMemo(() => singleScene(run), [run]);
  const samples = scene.tracks[0]?.samples ?? [];
  const series = useMemo(() => speeds(samples), [samples]);
  const started = Date.parse(run.recorded_at);
  return (
    <ChapterShell
      label="Guided walkthrough"
      navLabel="Walkthrough chapters"
      chapters={chapters}
      chapter={chapter}
      go={go}
      heading={heading}
      back="Back to briefing"
      facts={
        <>
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
          <a href={asset('walkthrough.json')} download>
            Download the run
          </a>
        </>
      }
    >
      {chapter === 0 && (
        <>
          <p className="chapter-lead">The objective is bigger than arriving at a waypoint.</p>
          <p>
            Inspect the bay, check the loading dock, and return to charge. The operator reviews the
            complete sequence before dispatch, including what may continue after an anomaly.
          </p>
          <RouteSheet
            caption="Reviewed inspection round"
            steps={run.steps.map((step, index) => ({
              title: step.title,
              command: step.command,
              continues: step.continue_on_missing_marker,
              policy: step.continue_on_missing_marker
                ? 'A validated image with no marker is recorded as an anomaly; the round may continue.'
                : 'Failure stops the round for review.',
              ...(index === run.steps.length - 1 ? { note: 1 } : {}),
            }))}
            block={[
              ['Round', <code key="r">{run.round_id}</code>],
              ['Authored by', 'Operator'],
              ['Camera frames judged by', 'Local vision model'],
              ['Plan digest, SHA-256', <code key="d">{run.digest}</code>, 'wide'],
            ]}
            notes={[
              <>
                <strong>The interruption is part of the test.</strong> During the return leg, the
                core process is killed. The rover must stop, retain its work and wait for an
                operator to approve recovery.
              </>,
            ]}
          />
        </>
      )}
      {chapter === 1 && (
        <ReplayPanel
          caption="Map-frame telemetry from the recorded run"
          scene={scene}
          label="Recorded rover path through the warehouse, with the bay, loading dock and charging station"
          twin={(time) => <RecordedTwin run={run} time={time} />}
          duration={run.duration_s}
          events={run.events}
          series={series}
          name="Recorded mission time"
          play="Play replay"
          pause="Pause replay"
          eventsLabel="Jump to a recorded event"
          idle={{ title: 'Round reviewed', detail: 'The approved plan is ready for the rover.' }}
          readouts={(time) => {
            const pose = run.poses.findLast((p) => p.t <= time) ?? run.poses[0];
            const velocity = series.findLast((sample) => sample.t <= time)?.v ?? 0;
            return [
              ['Position', pose ? `${signed(pose.x, 2)}, ${signed(pose.y, 2)} m` : '–'],
              ['Heading', `${signed(pose ? (pose.yaw * 180) / Math.PI : 0, 0)}°`],
              ['Speed', `${velocity.toFixed(2)} m/s`],
              ['State', pose?.status.replaceAll('_', ' ') ?? 'waiting'],
            ];
          }}
        />
      )}
      {chapter === 2 && (
        <>
          <p className="chapter-lead">A missing marker is a result worth keeping.</p>
          <div className="camera-grid">
            {run.evidence.map((e) => {
              const detection = e.detections[0];
              const captured =
                e.captured_at_ms === undefined ? null : (e.captured_at_ms - started) / 1000;
              return (
                <EvidencePlate
                  key={e.image}
                  src={asset(e.image)}
                  alt={
                    detection
                      ? 'Gazebo camera image with detected red safety marker'
                      : 'Gazebo loading-dock camera image with no supported marker detected'
                  }
                  title={e.title}
                  status={detection ? 'Marker detected' : 'No supported marker'}
                  found={detection !== undefined}
                  box={detection?.box}
                  label={e.outcome}
                  block={[
                    ['Source', 'Gazebo rover camera'],
                    [
                      'Captured',
                      captured === null ? 'Not recorded' : `${seconds(captured)} into the run`,
                    ],
                    [
                      'Detector score',
                      detection ? `${(detection.confidence * 100).toFixed(1)}%` : 'No detection',
                    ],
                    ['Model', <code key="m">{e.model_id}</code>],
                    ['Image SHA-256', <code key="h">{e.image_sha256}</code>, 'wide'],
                  ]}
                >
                  <p>
                    {detection
                      ? 'The inspection succeeded with evidence.'
                      : 'The inspection failed with image evidence. Its reviewed policy allowed the round to continue.'}
                  </p>
                  <p className="scope-note">{e.confidence_domain}</p>
                  <details>
                    <summary>Model and image provenance</summary>
                    <p>{e.model_id}</p>
                    <code>JPEG SHA-256: {e.image_sha256}</code>
                    <code>Frame SHA-256: {e.frame_sha256}</code>
                  </details>
                  <a href={asset(e.image)} download>
                    Original annotated image
                  </a>
                </EvidencePlate>
              );
            })}
          </div>
          <section className="limits" aria-labelledby="limits-title">
            <h3 id="limits-title">Measured model limits</h3>
            <dl className="readouts">
              <div>
                <dt>Clear requests resolved</dt>
                <dd>9 of 12</dd>
              </div>
              <div>
                <dt>Negative cases accepted</dt>
                <dd>0 of 24</dd>
              </div>
              <div>
                <dt>Marker precision</dt>
                <dd>100%</dd>
              </div>
              <div>
                <dt>Marker recall</dt>
                <dd>98.3%</dd>
              </div>
            </dl>
            <p>
              Language results come from 36 held-out requests; marker results from 600 synthetic
              crops at a 0.8 score threshold. They do not establish physical-camera accuracy.
            </p>
            <a href={asset('evaluation.json')} download>
              Read the full evaluation
            </a>
          </section>
        </>
      )}
      {chapter === 3 && (
        <>
          <p className="chapter-lead">The process disappears. The mission context survives.</p>
          <p>
            Three interlocks govern the restart. Step through the moments the run recorded: live
            wire is drawn heavy and green, and a held round is hatched in orange.
          </p>
          <RecoveryLadder run={run} />
          <dl className="readouts">
            <div>
              <dt>Old motion stopped in</dt>
              <dd>{seconds(run.recovery.stop_observed_after_s, 2)}</dd>
            </div>
            <div>
              <dt>Drift after stopping</dt>
              <dd>{(run.recovery.post_stop_drift_m * 100).toFixed(1)} cm</dd>
            </div>
            <div>
              <dt>Automatic resumes</dt>
              <dd>{run.recovery.automatic_resume ? 'Yes' : 'None'}</dd>
            </div>
            <div>
              <dt>Camera results kept</dt>
              <dd>{run.evidence.length}</dd>
            </div>
          </dl>
          <p className="scope-note">
            Measured in this simulator run. Local watchdogs also cover longer outages. These are not
            hardware timing guarantees.
          </p>
        </>
      )}
      {chapter === 4 && (
        <>
          <p className="chapter-lead">Each component has a narrow authority.</p>
          <Schematic digest={run.digest} frame={run.evidence[0]?.frame_sha256} source={source} />
          <div className="engineering-notes">
            <div>
              <h3>What is implemented</h3>
              <p>
                Durable reviewed rounds, signed commands, body identity, OIDC roles, fresh camera
                evidence, local motion limits and restart recovery.
              </p>
            </div>
            <div>
              <h3>What the evidence covers</h3>
              <p>
                One simulated warehouse, a small evaluated language corpus and a synthetic marker
                classifier. Hardware, broader perception and multi-fleet operation need separate
                validation.
              </p>
            </div>
          </div>
        </>
      )}
    </ChapterShell>
  );
}
