import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AdaptiveRecording } from './adaptiveTypes';
import type { CapabilityRecording } from './capabilityTypes';
import type { Cue } from './drawing/director';
import type { Scan } from './drawing/geometry';
import { LatticeDrawing } from './drawing/LatticeDrawing';
import {
  adaptiveScene,
  capabilityScene,
  handoffScene,
  type Scene,
  type StoryId,
  singleScene,
} from './drawing/scenes';
import type { HandoffRecording } from './handoffTypes';
import type { Walkthrough } from './types';

export interface Recordings {
  readonly single: Walkthrough | null;
  readonly handoff: HandoffRecording | null;
  readonly capability: CapabilityRecording | null;
  readonly adaptive: AdaptiveRecording | null;
}

const asset = (file: string) => `${import.meta.env.BASE_URL}demo/${file}`;
const hex = (buffer: ArrayBuffer) =>
  Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');

/** The blockage scan, drawn only when its bytes match the hash bound into the authenticated condition. */
function useVerifiedScan(run: AdaptiveRecording | null): Scan | null {
  const [scan, setScan] = useState<Scan | null>(null);
  useEffect(() => {
    setScan(null);
    if (!run) return;
    const abort = new AbortController();
    fetch(asset(run.lidar_scan.file), { signal: abort.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const bytes = await response.arrayBuffer();
        if (hex(await crypto.subtle.digest('SHA-256', bytes)) !== run.lidar_scan.sha256) return;
        const value = JSON.parse(new TextDecoder().decode(bytes)) as Scan;
        if (value.ranges?.length === run.lidar_scan.samples && !abort.signal.aborted)
          setScan(value);
      })
      .catch(() => {
        /* Without a verified scan the drawing shows the route and paths only. */
      });
    return () => abort.abort();
  }, [run]);
  return scan;
}

const copy: Record<
  StoryId,
  { title: readonly [string, string]; lead: string; doc: string; drawing: string }
> = {
  adaptive: {
    title: ['The aisle is blocked.', 'The objective continues.'],
    lead: 'A real Gazebo lidar condition holds the route. An operator reviews a west-aisle detour without repeating the completed inspection.',
    doc: 'ADAPTIVE_DEMO.md',
    drawing:
      'Warehouse route map: the lidar scan that closed the direct aisle, the reviewed west-aisle detour, and the recorded rover and Go1 paths',
  },
  capability: {
    title: ['The objective needs stairs.', 'The body can change.'],
    lead: 'A rover inspects the bay. A capability-aware plan selects a Go1 for the stairs.',
    doc: 'CAPABILITY_ROUTES.md',
    drawing:
      'Warehouse route map with the stair segment, and the recorded rover and Go1 paths meeting at the transfer point',
  },
  handoff: {
    title: ['Two bodies. One objective.', 'The evidence stays.'],
    lead: 'Rover A records an inspection. Rover B acknowledges its shared context and finishes the reviewed round.',
    doc: 'SHOWCASE.md',
    drawing:
      'Warehouse map with the recorded paths of rover A, which stops for the handoff, and rover B',
  },
  single: {
    title: ['Inspect. Find the exception.', 'Recover and finish.'],
    lead: 'Follow a rover through two safety inspections, a missing marker and a core restart. Every pose and camera image comes from the working Gazebo simulator.',
    doc: 'SHOWCASE.md',
    drawing:
      'Warehouse map with the rover’s recorded path, the missing-marker inspection and the point where the core was interrupted',
  },
};

function readouts(story: StoryId, recordings: Recordings): [string, string][] {
  const { adaptive, capability, handoff, single } = recordings;
  if (story === 'adaptive' && adaptive)
    return [
      ['Blockage reported at', `${adaptive.adaptation.block_observed_s.toFixed(1)} s`],
      ['Detour proposed in', `${Math.round(adaptive.adaptation.replan_proposal_ms)} ms`],
      ['Held until approval', `${adaptive.adaptation.hold_to_approval_s.toFixed(1)} s`],
      ['Inspections repeated', String(adaptive.adaptation.repeated_inspections)],
    ];
  if (story === 'capability' && capability) {
    const distance = (id: string) => `${(capability.distance_by_body_m[id] ?? 0).toFixed(2)} m`;
    return [
      ['Rover distance', distance(capability.handoff.source_body_id)],
      ['Go1 distance', distance(capability.handoff.target_body_id)],
      [
        'Steps contacted',
        `${capability.quadruped.contact_steps.length} of ${capability.quadruped.step_count}`,
      ],
      ['Maximum tilt', `${((capability.quadruped.max_tilt_rad * 180) / Math.PI).toFixed(1)}°`],
    ];
  }
  if (story === 'handoff' && handoff) {
    const distance = (id: string) => `${(handoff.distance_by_body_m[id] ?? 0).toFixed(2)} m`;
    return [
      ['Rover A distance', distance(handoff.handoff.source_body_id)],
      ['Rover B distance', distance(handoff.handoff.target_body_id)],
      ['Rover A stopped in', `${handoff.handoff.source_stop_observed_after_s.toFixed(2)} s`],
      ['Drift after stopping', `${(handoff.handoff.post_stop_drift_m * 100).toFixed(1)} cm`],
    ];
  }
  if (story === 'single' && single)
    return [
      ['Recorded path', `${single.distance_m.toFixed(1)} m`],
      ['Old motion stopped in', `${single.recovery.stop_observed_after_s.toFixed(2)} s`],
      ['Drift after stopping', `${(single.recovery.post_stop_drift_m * 100).toFixed(1)} cm`],
      ['Camera results kept', String(single.evidence.length)],
    ];
  return [];
}

function sceneFor(story: StoryId, recordings: Recordings, scan: Scan | null): Scene | null {
  if (story === 'adaptive') return recordings.adaptive && adaptiveScene(recordings.adaptive, scan);
  if (story === 'capability')
    return recordings.capability && capabilityScene(recordings.capability);
  if (story === 'handoff') return recordings.handoff && handoffScene(recordings.handoff);
  return recordings.single && singleScene(recordings.single);
}

function useReducedMotion() {
  const [reduce, setReduce] = useState(
    () => window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  );
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const follow = () => setReduce(media.matches);
    media.addEventListener('change', follow);
    return () => media.removeEventListener('change', follow);
  }, []);
  return reduce;
}

export function StoryOpening({
  story,
  recordings,
  source,
  onExplore,
}: {
  readonly story: StoryId;
  readonly recordings: Recordings;
  readonly source: string;
  /** Opens the single-rover walkthrough at its replay; other stories link to their chapters. */
  readonly onExplore: () => void;
}) {
  const still = useReducedMotion();
  // A newly chosen story waits while the drawing on screen is erased, then draws in its place.
  const [shown, setShown] = useState(story);
  const [erasing, setErasing] = useState(false);
  const [continued, setContinued] = useState(false);
  const wanted = useRef(story);
  const text = copy[shown];
  const scan = useVerifiedScan(shown === 'adaptive' ? recordings.adaptive : null);
  const scene = useMemo(() => sceneFor(shown, recordings, scan), [shown, recordings, scan]);
  const drawn = scene !== null;
  useEffect(() => {
    wanted.current = story;
    if (story === shown) return;
    if (still || !drawn) setShown(story);
    else setErasing(true);
  }, [story, shown, still, drawn]);
  const erased = useCallback(() => {
    setShown(wanted.current);
    setErasing(false);
    setContinued(true);
  }, []);
  const [again, setAgain] = useState(0);
  const [paused, setPaused] = useState(false);
  // The headline's two lines appear on the story's beats in the drawing; with reduced motion they are
  // simply there. They stay in the document throughout, so screen readers always have them.
  const [lines, setLines] = useState(still ? 2 : 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new drawing hides the lines again.
  useEffect(() => {
    if (still) return setLines(2);
    setLines(0);
    const fallback = window.setTimeout(() => setLines(2), 9000);
    return () => window.clearTimeout(fallback);
  }, [shown, again, still]);
  const cue = useCallback(
    (beat: Cue) => setLines((count) => Math.max(count, beat === 'first' ? 1 : 2)),
    [],
  );
  const values = readouts(shown, recordings);
  return (
    <section className="opening" aria-labelledby="opening-title">
      <div className="opening-text">
        <h1 id="opening-title">
          <span className="line" data-shown={lines >= 1 ? '' : undefined}>
            {text.title[0]}
          </span>{' '}
          <span className="line" data-shown={lines >= 2 ? '' : undefined}>
            {text.title[1]}
          </span>
        </h1>
        <p className="lead">{text.lead}</p>
        <div className="actions">
          {shown === 'single' ? (
            <button type="button" className="button primary" onClick={onExplore}>
              Explore this recording
            </button>
          ) : (
            <a className="button primary" href="#chapter">
              Explore this recording
            </a>
          )}
          <a className="button" href={`${source}/blob/main/docs/${text.doc}`}>
            Run it yourself
          </a>
        </div>
        <p className="note">
          A recorded simulation. Nothing on this page connects to a robot, and no sign-in is needed.
        </p>
      </div>
      <figure className="plate opening-plate">
        <div className="drawing-frame">
          {scene ? (
            <LatticeDrawing
              scene={scene}
              label={text.drawing}
              mode="plot"
              run={again}
              paused={paused}
              live
              erasing={erasing}
              continued={continued}
              onCue={cue}
              onErased={erased}
            />
          ) : (
            <p role="status">Loading the recording…</p>
          )}
        </div>
        <figcaption>
          {values.length > 0 && (
            <dl className="readouts">
              {values.map(([name, value]) => (
                <div key={name}>
                  <dt>{name}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {scene && !still && (
            <div className="plate-actions">
              <button type="button" className="text-button" onClick={() => setPaused(!paused)}>
                {paused ? 'Resume motion' : 'Pause motion'}
              </button>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setPaused(false);
                  setContinued(false);
                  setAgain(again + 1);
                }}
              >
                Draw it again
              </button>
            </div>
          )}
        </figcaption>
      </figure>
    </section>
  );
}
