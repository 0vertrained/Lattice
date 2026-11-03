import './stories.css';
import { lazy, useMemo, useState } from 'react';
import { ChapterShell, type Opened, useChapters } from './chapters/ChapterShell';
import { EvidencePlate } from './chapters/EvidencePlate';
import { LogicTrace } from './chapters/LogicTrace';
import { bodyReadouts, ReplayPanel } from './chapters/ReplayPanel';
import { speeds } from './chapters/ReplayTrace';
import { RouteSheet, TitleBlock } from './chapters/RouteSheet';
import { handoffScene } from './drawing/scenes';
import { minutes as fmt } from './format';
import type { HandoffRecording } from './handoffTypes';

const RecordedTwin = lazy(() => import('./RecordedTwin'));
const chapters = [
  'Shared objective',
  'Two-rover replay',
  'Shared memory',
  'Handoff proof',
] as const;
const asset = (file: string) => `${import.meta.env.BASE_URL}demo/${file}`;
const when = (iso: string) => new Date(iso).toLocaleString();
const seconds = (value: number) => `${value.toFixed(1)} s`;
const stationName = (value: string) => {
  const name = value.replaceAll('_', ' ');
  return name.charAt(0).toUpperCase() + name.slice(1);
};
const bodyName = (id: string, run: HandoffRecording) =>
  id === run.handoff.source_body_id
    ? 'Rover A'
    : id === run.handoff.target_body_id
      ? 'Rover B'
      : id;

export default function HandoffStory({
  run,
  opened,
}: {
  readonly run: HandoffRecording;
  readonly opened: Opened | null;
}) {
  const { chapter, go, heading } = useChapters(opened);
  const scene = useMemo(() => handoffScene(run), [run]);
  const series = useMemo(() => scene.tracks.map((track) => speeds(track.samples)), [scene]);
  const since = (iso: string) => (Date.parse(iso) - Date.parse(run.recorded_at)) / 1000;
  const held = run.events.find((event) => event.kind === 'handoff')?.t;
  const approved = since(run.handoff.approved_at);
  return (
    <ChapterShell
      label="Two-rover continuation walkthrough"
      className="handoff-story"
      navLabel="Two-rover chapters"
      chapters={chapters}
      chapter={chapter}
      go={go}
      heading={heading}
      back="Back to objective"
      facts={
        <>
          <span>Recorded {new Date(run.recorded_at).toLocaleDateString()}</span>
          <span>{fmt(run.duration_s)} elapsed</span>
          {Object.entries(run.distance_by_body_m).map(([id, distance]) => (
            <span key={id}>
              {bodyName(id, run)}: {distance.toFixed(1)} m reported path
            </span>
          ))}
          <a href={asset('handoff.json')} download>
            Download the handoff run
          </a>
        </>
      }
    >
      {chapter === 0 && (
        <>
          <p className="chapter-lead">The body changes. The objective and its evidence survive.</p>
          <p>
            Rover A inspects the bay, then begins the next leg. An operator holds its round and
            reviews a transfer. After A’s execution window closes, rover B receives the remaining
            steps and acknowledges the retained observation context.
          </p>
          <RouteSheet
            caption="One objective, two bodies"
            columns={['Step', 'Operation and command', 'Carried out by']}
            steps={run.steps.map((step, index) => {
              const before = index < run.handoff.completed_steps;
              return {
                title: step.title,
                command: step.command,
                done: before,
                continues: !before && step.continue_on_missing_marker,
                detail: (
                  <>
                    <strong>{before ? 'Rover A' : 'Rover B'}</strong>
                    {before
                      ? 'Completed before the handoff; its evidence stays in shared memory'
                      : step.continue_on_missing_marker
                        ? 'A validated no-marker image records an anomaly and the round continues'
                        : 'Continued under the reviewed transfer'}
                  </>
                ),
              };
            })}
            block={[
              ['Round', <code key="r">{run.round_id}</code>],
              ['Plan digest, SHA-256', <code key="d">{run.digest}</code>, 'wide'],
            ]}
            notes={[
              <>
                <strong>What this demonstrates.</strong> Continuity between two independently
                executing simulated rover instances in one warehouse. This run uses the same body
                type and adapter; transfer to a quadruped, drone or physical robot requires separate
                validation.
              </>,
            ]}
          />
        </>
      )}
      {chapter === 1 && (
        <>
          <ReplayPanel
            caption="Recorded map-frame telemetry from both body instances"
            scene={scene}
            label="Recorded paths of rover A and rover B in the shared warehouse map"
            twin={(time) => <RecordedTwin run={run} time={time} />}
            duration={run.duration_s}
            events={run.events}
            series={series}
            name="Handoff replay time"
            play="Play handoff replay"
            pause="Pause handoff replay"
            eventsLabel="Jump to a handoff event"
            speeds={[1, 2, 4]}
            initialSpeed={2}
            idle={{
              title: 'Two bodies registered',
              detail: 'The operator-authored round is ready for explicit approval.',
            }}
            readouts={(time) => bodyReadouts(scene, time)}
          />
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
          <LogicTrace
            label={`Rover A moves until the handoff hold at ${seconds(held ?? 0)}, then stands; rover B starts after the approval at ${seconds(approved)}`}
            duration={run.duration_s}
            channels={scene.tracks.map((track, index) => ({
              label: track.label,
              tone: track.tone,
              speeds: series[index] ?? [],
            }))}
            held={held === undefined ? null : { from: held, to: approved }}
            markers={[
              ...(held === undefined
                ? []
                : [{ t: held, label: `Held for handoff, ${seconds(held)}` }]),
              { t: approved, label: `Approved, ${seconds(approved)}` },
            ]}
          />
          <p className="scope-note">
            Each channel is high while that rover’s recorded poses show it moving. The hatched band
            is the time rover A’s work was held for review.
          </p>
          <dl className="readouts">
            <div>
              <dt>Rover A stopped in</dt>
              <dd>{run.handoff.source_stop_observed_after_s.toFixed(2)} s</dd>
            </div>
            <div>
              <dt>Drift after stopping</dt>
              <dd>{(run.handoff.post_stop_drift_m * 100).toFixed(1)} cm</dd>
            </div>
            <div>
              <dt>Steps transferred</dt>
              <dd>{run.handoff.remaining_steps}</dd>
            </div>
            <div>
              <dt>Anomalies recorded</dt>
              <dd>{run.anomaly_count}</dd>
            </div>
          </dl>
          <RouteSheet
            caption="Transfer record"
            columns={['Step', 'Check', 'Recorded']}
            steps={[
              {
                title: 'Hold the round and retire A’s command',
                text: 'The proposal freezes source, target, completed steps and observation references. The old body loses execution renewal; approval waits through its signed command window and stop margin.',
                detail: (
                  <>
                    {held !== undefined && (
                      <span className="sheet-line">Held at {seconds(held)}</span>
                    )}
                    <span className="sheet-line">
                      Window closed at {seconds(since(run.handoff.not_before_at))}
                    </span>
                  </>
                ),
              },
              {
                title: 'Approve the exact continuation',
                text: 'An operator approves the immutable digest. The core rechecks B’s availability and capabilities before dispatching the remaining task.',
                detail: `Approved at ${seconds(approved)}`,
              },
              {
                title: 'B acknowledges the shared context',
                text: 'The target checks the signed context and acknowledges its digest. The original image remains historical evidence; the new inspection produces its own frame and result.',
                detail: `Acknowledged at ${seconds(since(run.handoff.context_acknowledged_at))}`,
              },
            ]}
            block={[
              ['Handoff', <code key="h">{run.handoff.id}</code>],
              [
                'Outcome',
                run.outcome === 'completed'
                  ? `Completed, with ${run.observations.length} camera observations kept across both bodies`
                  : `Recorded outcome: ${run.outcome}`,
              ],
            ]}
          />
          <details>
            <summary>Inspect the recorded approval and acknowledgement</summary>
            <TitleBlock
              cells={[
                ['Round', <code key="r">{run.round_id}</code>],
                [
                  'Source and target',
                  <code key="s">
                    {run.handoff.source_body_id}, then {run.handoff.target_body_id}
                  </code>,
                ],
                [
                  'Context digest acknowledged by B',
                  <code key="c">{run.handoff.context_digest}</code>,
                  'wide',
                ],
                ['Earliest approval', when(run.handoff.not_before_at)],
                ['Approved', when(run.handoff.approved_at)],
                ['Context acknowledged', when(run.handoff.context_acknowledged_at)],
              ]}
            />
          </details>
          <p className="scope-note">
            Measured in this simulator run. Reported stop time and drift are observations from this
            recording, not hardware timing guarantees. Shared context contains retained observation
            references, not a learned world model.
          </p>
        </>
      )}
    </ChapterShell>
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
              Safety marker at {location.replaceAll('_', ' ')}
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
          <EvidencePlate
            key={observation.id}
            src={asset(observation.image)}
            alt={`Recorded ${bodyName(observation.body_id, run)} camera at ${observation.location.replaceAll('_', ' ')}; ${observation.outcome === 'detected' ? 'marker detected' : 'no supported marker detected'}`}
            title={stationName(observation.location)}
            status={
              observation.outcome === 'detected' ? 'Last positive sighting' : 'No supported marker'
            }
            found={observation.outcome === 'detected'}
            box={observation.detections?.[0]?.box}
            label={bodyName(observation.body_id, run)}
            block={[
              ['Captured', when(observation.captured_at)],
              [
                'Detector score',
                observation.confidence === null
                  ? 'No detection score'
                  : `${(observation.confidence * 100).toFixed(1)}%`,
              ],
            ]}
          >
            {observation.confidence === null && (
              <p>This image does not establish absence across the entire station.</p>
            )}
            <p className="scope-note">{observation.confidence_domain}</p>
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
              <p>Received: {when(observation.received_at)}</p>
              <p>
                Observer pose in {observation.map_frame}:{' '}
                {observation.observer_pose
                  ? `x ${observation.observer_pose.x.toFixed(2)} m, y ${observation.observer_pose.y.toFixed(2)} m, yaw ${observation.observer_pose.yaw.toFixed(2)} rad`
                  : 'not available'}
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
      <section className="limits" aria-labelledby="memory-title">
        <h3 id="memory-title">History with provenance</h3>
        <p>
          These images were captured during the recorded missions. Scrubbing the replay does not
          create a new frame. The map position belongs to the observing rover; it does not locate
          the marker in 3D.
        </p>
      </section>
    </>
  );
}
