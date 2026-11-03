import type { AdaptiveRecording } from '../adaptiveTypes';
import type { CapabilityRecording } from '../capabilityTypes';
import type { HandoffRecording } from '../handoffTypes';
import type { Walkthrough } from '../types';
import {
  type Box,
  corridorOutline,
  type Point,
  type Pose,
  poseAt,
  type Scan,
  scanReturns,
  simplify,
} from './geometry';

export type StoryId = 'adaptive' | 'capability' | 'handoff' | 'single';
export interface Place {
  readonly id: string;
  readonly label: string;
  readonly at: Point;
  /** Arrival radius in metres when the recording states one. */
  readonly radius: number | null;
  /** Height in the map frame, when the route map gives one. */
  readonly z?: number;
}
export interface Lane {
  readonly id: string;
  /** Place ids at either end, in the segment's direction. */
  readonly ends: readonly [string, string];
  /** Capabilities a body needs to traverse it, such as stairs. */
  readonly needs: readonly string[];
  readonly from: Point;
  readonly to: Point;
  readonly length: number;
  /** In the plan the body was first approved to follow. */
  readonly planned: boolean;
  /** Closed by a measured condition after approval. */
  readonly blocked: boolean;
  /** Added by the reviewed replan. */
  readonly replanned: boolean;
}
export interface Solid {
  readonly box: Box;
  readonly kind: 'wall' | 'shelf' | 'barrier';
}
export interface Track {
  readonly id: string;
  readonly label: string;
  readonly tone: 'ink' | 'body';
  /** Path vertices: the recording without samples where the body stood still. */
  readonly poses: readonly Pose[];
  /** Every recorded sample, for heading and position at a given time. */
  readonly samples: readonly Pose[];
}
export interface Mark {
  readonly kind: 'stop' | 'hold' | 'transfer';
  readonly track: number;
  readonly t: number;
  readonly label: string;
}
export interface Scene {
  readonly story: StoryId;
  readonly bounds: Box;
  readonly solids: readonly Solid[];
  readonly places: readonly Place[];
  readonly lanes: readonly Lane[];
  readonly stairs: {
    readonly risers: readonly number[];
    readonly y0: number;
    readonly y1: number;
  } | null;
  readonly scan: {
    readonly origin: Point;
    /** Map-frame direction of the first beam, so a sweep reveals beams in recorded order. */
    readonly start: number;
    readonly rays: readonly (Point & { hit: boolean; beam: number })[];
    /** Beams in the recorded sweep, including any without a usable return. */
    readonly beams: number;
    readonly corridor: readonly Point[];
    readonly hits: number;
  } | null;
  /** The planned route's endpoints, for showing the planner's search over the map's segments. */
  readonly route: { readonly from: string; readonly to: string } | null;
  readonly tracks: readonly Track[];
  readonly marks: readonly Mark[];
}

// Static Gazebo geometry from simulation/warehouse/generate_world.py: (centre x, centre y, width, depth).
const box = (x: number, y: number, w: number, d: number): Box => ({
  x0: x - w / 2,
  y0: y - d / 2,
  x1: x + w / 2,
  y1: y + d / 2,
});
const warehouse: Solid[] = [
  { box: box(0, -4, 10.2, 0.2), kind: 'wall' },
  { box: box(0, 4, 10.2, 0.2), kind: 'wall' },
  { box: box(-5, 0, 0.2, 8), kind: 'wall' },
  { box: box(5, 0, 0.2, 8), kind: 'wall' },
  { box: box(2, 0, 0.7, 1.8), kind: 'shelf' },
];
const bounds: Box = { x0: -5.1, y0: -4.1, x1: 5.1, y1: 4.1 };
// simulation/warehouse/locations.json
const stations: Place[] = [
  { id: 'inspection_bay', label: 'Inspection bay', at: { x: 0, y: 2.5 }, radius: null },
  { id: 'loading_dock', label: 'Loading dock', at: { x: 3.5, y: 0 }, radius: null },
  { id: 'charging_station', label: 'Charging station', at: { x: -3, y: -2 }, radius: null },
];
// MuJoCo stair edges from simulation/quadruped/controller.py (base x 1.0, 1.4, 1.8; |base y| < 1),
// moved into the map frame by the documented transform map_x = base_x + 1, map_y = base_y − 2.
const stairs = { risers: [2, 2.4, 2.8], y0: -3, y1: -1 };

const shortLabel = (label: string) => label.split(' · ')[0] ?? label;
const track = (
  poses: readonly { t: number; x: number; y: number; yaw: number; body_id?: string }[],
  id: string,
  label: string,
  tone: Track['tone'],
): Track => {
  const samples = poses
    .filter((pose) => pose.body_id === undefined || pose.body_id === id)
    .map(({ t, x, y, yaw }) => ({ t, x, y, yaw }));
  return { id, label, tone, poses: simplify(samples), samples };
};

function routeMap(
  run: Pick<CapabilityRecording, 'map'>,
  planned: ReadonlySet<string>,
  replanned: ReadonlySet<string>,
  blocked: string | null,
) {
  const places = run.map.places.map((place) => ({
    id: place.id,
    label: shortLabel(place.label),
    at: { x: place.pose.x, y: place.pose.y },
    radius: place.arrival_radius_m,
    z: place.pose.z ?? 0,
  }));
  const lanes = run.map.segments.flatMap((segment) => {
    const from = places.find((place) => place.id === segment.from),
      to = places.find((place) => place.id === segment.to);
    if (!from || !to) return [];
    return [
      {
        id: segment.id,
        ends: [segment.from, segment.to] as const,
        needs: segment.required_capabilities,
        from: from.at,
        to: to.at,
        // Straight-line length between the place poses, height included, as the planner measures it.
        length: Math.hypot(to.at.x - from.at.x, to.at.y - from.at.y, (to.z ?? 0) - (from.z ?? 0)),
        planned: planned.has(segment.id),
        blocked: segment.id === blocked,
        replanned: replanned.has(segment.id) && !planned.has(segment.id),
      },
    ];
  });
  return { places, lanes };
}

export function capabilityScene(run: CapabilityRecording): Scene {
  const legs = new Set(run.plan.legs.map((leg) => leg.segment_id));
  const { places, lanes } = routeMap(run, legs, new Set(), null);
  const source = run.handoff.source_body_id,
    target = run.handoff.target_body_id;
  const transfer = run.events.find((event) => event.kind === 'handoff');
  return {
    story: 'capability',
    bounds,
    solids: warehouse,
    places,
    lanes,
    stairs,
    scan: null,
    route: { from: run.plan.source_place_id, to: run.plan.destination_place_id },
    tracks: [
      track(run.poses, source, 'Gazebo rover', 'ink'),
      track(run.poses, target, 'MuJoCo Go1', 'body'),
    ],
    marks: transfer ? [{ kind: 'transfer', track: 0, t: transfer.t, label: transfer.title }] : [],
  };
}

export function adaptiveScene(run: AdaptiveRecording, scan: Scan | null): Scene {
  const blocked = run.adaptation.blocked_segment_id;
  const legs = (plan: AdaptiveRecording['plan']) => new Set(plan.legs.map((leg) => leg.segment_id));
  const { places, lanes } = routeMap(run, legs(run.initial_plan), legs(run.plan), blocked);
  const segment = run.map.segments.find((item) => item.id === blocked);
  const target = places.find((place) => place.id === segment?.to)?.at;
  const base = run.condition_observation.evidence?.observer_pose;
  const rays = scan && base && target ? scanReturns(scan, base, target) : [];
  const source = run.handoff.source_body_id,
    receiver = run.handoff.target_body_id;
  const condition = run.events.find((event) => event.kind === 'condition');
  const transfer = run.events.find((event) => event.kind === 'handoff');
  const { x, y } = run.obstacle.pose;
  return {
    story: 'adaptive',
    bounds,
    solids: [
      ...warehouse,
      // The barrier inserted after staging; its recorded pose has no rotation.
      { box: box(x, y, run.obstacle.size.x, run.obstacle.size.y), kind: 'barrier' },
    ],
    places,
    lanes,
    stairs,
    scan:
      scan && base && target
        ? {
            origin: scan.sensor_map_pose,
            start: scan.sensor_map_pose.yaw + scan.angle_min,
            rays,
            beams: scan.ranges.length,
            corridor: corridorOutline(base, target),
            hits: rays.filter((ray) => ray.hit).length,
          }
        : null,
    route: { from: run.plan.source_place_id, to: run.plan.destination_place_id },
    tracks: [
      track(run.poses, source, 'Gazebo rover', 'ink'),
      track(run.poses, receiver, 'MuJoCo Go1', 'body'),
    ],
    marks: [
      ...(condition
        ? [{ kind: 'stop' as const, track: 0, t: condition.t, label: condition.title }]
        : []),
      ...(transfer
        ? [{ kind: 'transfer' as const, track: 0, t: transfer.t, label: transfer.title }]
        : []),
    ],
  };
}

export function handoffScene(run: HandoffRecording): Scene {
  const source = run.handoff.source_body_id,
    receiver = run.handoff.target_body_id;
  const stopped = run.events.find((event) => event.kind === 'safety');
  const anomaly = run.events.find((event) => event.kind === 'anomaly');
  return {
    story: 'handoff',
    bounds,
    solids: warehouse,
    places: stations,
    lanes: [],
    stairs: null,
    scan: null,
    route: null,
    tracks: [
      track(run.poses, source, 'Rover A', 'ink'),
      track(run.poses, receiver, 'Rover B', 'body'),
    ],
    marks: [
      ...(stopped ? [{ kind: 'stop' as const, track: 0, t: stopped.t, label: stopped.title }] : []),
      ...(anomaly ? [{ kind: 'hold' as const, track: 1, t: anomaly.t, label: anomaly.title }] : []),
    ],
  };
}

export function singleScene(run: Walkthrough): Scene {
  const interrupted = run.events.find((event) => event.kind === 'recovery');
  const anomaly = run.events.find((event) => event.kind === 'anomaly');
  return {
    story: 'single',
    bounds,
    solids: warehouse,
    places: stations,
    lanes: [],
    stairs: null,
    scan: null,
    route: null,
    tracks: [track(run.poses, 'rover', 'Rover', 'ink')],
    marks: [
      ...(anomaly
        ? [{ kind: 'hold' as const, track: 0, t: anomaly.t, label: 'Missing marker recorded' }]
        : []),
      ...(interrupted
        ? [{ kind: 'stop' as const, track: 0, t: interrupted.t, label: interrupted.title }]
        : []),
    ],
  };
}

/** Where a mark sits: the marked body's recorded position at the event time. */
export function markPose(scene: Scene, mark: Mark): Pose | undefined {
  return poseAt(scene.tracks[mark.track]?.samples ?? [], mark.t);
}

/**
 * The route alone, before or after a replan: `original` shows the approved route with nothing yet
 * closed; `detour` shows the reviewed remainder with the closed lane hatched and unfilled.
 */
export function routeScene(scene: Scene, stage: 'original' | 'detour'): Scene {
  return {
    ...scene,
    tracks: [],
    marks: [],
    lanes: scene.lanes.map((lane) =>
      stage === 'original'
        ? { ...lane, blocked: false, replanned: false }
        : lane.blocked
          ? { ...lane, planned: false }
          : lane,
    ),
  };
}
