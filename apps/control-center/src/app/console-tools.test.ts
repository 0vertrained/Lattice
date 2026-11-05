import { describe, expect, it } from 'vitest';
import type { AuditRecord } from '../core/api/schemas';
import { ledgerRows } from '../features/audit/AuditPanel';
import { ANNOUNCE_EVERY_S, fenceState } from '../features/guard/FenceTimer';
import type { RoutePlan, SemanticMap } from '../features/navigation/navigation';
import {
  mapView,
  rankRoutes,
  revealSearch,
  STEP_MAX_MS,
  STEP_MIN_MS,
  TRACE_MS,
  VIEW_WIDTH,
} from '../features/navigation/routeDrawing';
import { speed } from '../features/navigation/routeNames';

// The warehouse map and the planner's own output for it: a rover at the inspection bay, a
// quadruped staged at the stair transfer, inspecting the upper station.
const segment = (id: string, from: string, to: string, stairs = false) => ({
  id,
  from,
  to,
  required_capabilities: stairs ? ['navigate' as const, 'stairs' as const] : ['navigate' as const],
  max_speed_mps: 0.3,
  enabled: true,
});
const map: SemanticMap = {
  id: 'warehouse_adaptive',
  revision: 1,
  frame_id: 'map',
  places: [
    {
      id: 'inspection_bay',
      label: 'Inspection bay · ground floor',
      pose: { x: 0, y: 2.5, z: 0 },
      arrival_radius_m: 0.35,
      transfer_allowed: false,
    },
    {
      id: 'west_bypass',
      label: 'West aisle · alternate route',
      pose: { x: -2, y: 2.2, z: 0 },
      arrival_radius_m: 0.35,
      transfer_allowed: false,
    },
    {
      id: 'stair_transfer',
      label: 'Stair transfer · staging area',
      pose: { x: 1, y: -2, z: 0 },
      arrival_radius_m: 0.35,
      transfer_allowed: true,
    },
    {
      id: 'upper_inspection',
      label: 'Upper inspection · raised platform',
      pose: { x: 4.5, y: -2, z: 0.15 },
      arrival_radius_m: 0.35,
      transfer_allowed: false,
    },
  ],
  segments: [
    segment('bay_to_transfer', 'inspection_bay', 'stair_transfer'),
    segment('bay_to_west_bypass', 'inspection_bay', 'west_bypass'),
    segment('west_bypass_to_transfer', 'west_bypass', 'stair_transfer'),
    segment('stairs_to_upper', 'stair_transfer', 'upper_inspection', true),
  ],
};
const leg = (
  segment_id: string,
  body_id: string,
  from: string,
  to: string,
  distance_m: number,
) => ({
  segment_id,
  body_id,
  from,
  to,
  from_pose: { x: 0, y: 0, z: 0 },
  to_pose: { x: 0, y: 0, z: 0 },
  arrival_radius_m: 0.35,
  required_capabilities: ['navigate' as const],
  max_speed_mps: 0.3,
  distance_m,
});
const plan: RoutePlan = {
  planner_id: 'semantic-capability-dijkstra-v1',
  map_id: map.id,
  map_revision: 1,
  map_digest: '8fb9756c65531c1c94e99013f16de18c5e37d4cac7d7074952ae643a584e5248',
  source_body_id: 'gazebo-rover',
  source_place_id: 'inspection_bay',
  destination_place_id: 'upper_inspection',
  destination_capability: 'inspect',
  destination_body_id: 'mujoco-go1',
  legs: [
    leg('bay_to_transfer', 'gazebo-rover', 'inspection_bay', 'stair_transfer', 4.6097722286464435),
    leg('stairs_to_upper', 'mujoco-go1', 'stair_transfer', 'upper_inspection', 3.503212811120672),
  ],
  transfers: [
    {
      place_id: 'stair_transfer',
      source_body_id: 'gazebo-rover',
      target_body_id: 'mujoco-go1',
      before_leg_index: 1,
      reason: 'gazebo-rover lacks [stairs] needed after stair_transfer.',
    },
  ],
  distance_m: 8.112985039767116,
  explanation: [],
  assessments: [],
  search: [
    {
      reached_by: 'start',
      place_id: 'inspection_bay',
      body_id: 'gazebo-rover',
      segment_id: null,
      transfers: 0,
      distance_m: 0,
    },
    {
      reached_by: 'leg',
      place_id: 'west_bypass',
      body_id: 'gazebo-rover',
      segment_id: 'bay_to_west_bypass',
      transfers: 0,
      distance_m: 2.0223748416156684,
    },
    {
      reached_by: 'leg',
      place_id: 'stair_transfer',
      body_id: 'gazebo-rover',
      segment_id: 'bay_to_transfer',
      transfers: 0,
      distance_m: 4.6097722286464435,
    },
    {
      reached_by: 'leg',
      place_id: 'stair_transfer',
      body_id: 'gazebo-rover',
      segment_id: 'west_bypass_to_transfer',
      transfers: 0,
      distance_m: 7.1837700018412445,
    },
    {
      reached_by: 'transfer',
      place_id: 'stair_transfer',
      body_id: 'mujoco-go1',
      segment_id: null,
      transfers: 1,
      distance_m: 4.6097722286464435,
    },
    {
      reached_by: 'leg',
      place_id: 'upper_inspection',
      body_id: 'mujoco-go1',
      segment_id: 'stairs_to_upper',
      transfers: 1,
      distance_m: 8.112985039767116,
    },
  ],
  alternatives: [
    {
      segment_ids: ['bay_to_west_bypass', 'west_bypass_to_transfer', 'stairs_to_upper'],
      body_ids: ['gazebo-rover', 'gazebo-rover', 'mujoco-go1'],
      transfer_place_ids: ['stair_transfer'],
      destination_body_id: 'mujoco-go1',
      distance_m: 10.686982812961917,
    },
  ],
};

describe('route map', () => {
  const view = mapView(map);
  const at = (id: string) => view.places.find((place) => place.id === id);
  it('draws the map to scale, north up, inside the drawing', () => {
    expect(view.width).toBe(VIEW_WIDTH);
    const bay = at('inspection_bay');
    const transfer = at('stair_transfer');
    if (!bay || !transfer) throw new Error('places missing');
    // 4.61 m between the bay and the transfer point, in drawing units.
    expect(Math.hypot(transfer.at.x - bay.at.x, transfer.at.y - bay.at.y) / view.scale).toBeCloseTo(
      4.61,
      1,
    );
    expect(bay.at.y).toBeLessThan(transfer.at.y);
    for (const place of view.places) {
      expect(place.at.x).toBeGreaterThan(0);
      expect(place.at.x).toBeLessThan(view.width);
      expect(place.at.y).toBeGreaterThan(0);
      expect(place.at.y).toBeLessThan(view.height);
    }
  });
  it('keeps labels short, marks raised places and sets names away from their lanes', () => {
    expect(view.places.map((place) => place.label)).toEqual([
      'Inspection bay',
      'West aisle',
      'Stair transfer',
      'Upper inspection',
    ]);
    expect(view.places.filter((place) => place.raised).map((place) => place.id)).toEqual([
      'upper_inspection',
    ]);
    expect(at('stair_transfer')?.below).toBe(true);
    expect(at('inspection_bay')?.below).toBe(false);
  });
  it('draws risers only on the stairs and lays two-way lanes side by side', () => {
    expect(view.lanes.filter((lane) => lane.risers).map((lane) => lane.id)).toEqual([
      'stairs_to_upper',
    ]);
    const twoWay = mapView({
      ...map,
      segments: [...map.segments, segment('west_to_bay', 'west_bypass', 'inspection_bay')],
    });
    const out = twoWay.lanes.find((lane) => lane.id === 'bay_to_west_bypass');
    const back = twoWay.lanes.find((lane) => lane.id === 'west_to_bay');
    expect(out?.d).not.toBe(mapView(map).lanes.find((lane) => lane.id === 'bay_to_west_bypass')?.d);
    expect(out?.d).not.toBe(back?.d);
  });
  it('rules a drafting grid with a heavier line every metre', () => {
    const majors = view.major.match(/M/g)?.length ?? 0;
    const minors = view.minor.match(/M/g)?.length ?? 0;
    expect(majors).toBeGreaterThan(8);
    // Three quarter-metre lines between metres, give or take the edges of the drawing.
    expect(Math.abs(minors - 3 * majors)).toBeLessThanOrEqual(6);
  });
});

describe('search drawing', () => {
  const reveal = revealSearch(plan);
  if (!reveal) throw new Error('expected a recorded search');
  it('plots each settled segment once, in the planner’s order', () => {
    expect(reveal.probes.map((probe) => probe.segmentId)).toEqual([
      'bay_to_west_bypass',
      'bay_to_transfer',
      'west_bypass_to_transfer',
      'stairs_to_upper',
    ]);
    const delays = reveal.probes.map((probe) => probe.delay);
    expect([...delays].sort((a, b) => a - b)).toEqual(delays);
    const step = (delays[1] ?? 0) - (delays[0] ?? 0);
    expect(step).toBeGreaterThanOrEqual(STEP_MIN_MS);
    expect(step).toBeLessThanOrEqual(STEP_MAX_MS);
  });
  it('labels each place with the cost at which the search first reached it', () => {
    expect(reveal.costs.map((cost) => [cost.placeId, Number(cost.distanceM.toFixed(2))])).toEqual([
      ['inspection_bay', 0],
      ['west_bypass', 2.02],
      ['stair_transfer', 4.61],
      ['upper_inspection', 8.11],
    ]);
    expect(reveal.changes).toEqual([
      expect.objectContaining({ placeId: 'stair_transfer', bodyId: 'mujoco-go1' }),
    ]);
  });
  it('traces the selected route back from the destination after the search', () => {
    expect(reveal.trace.map((entry) => entry.segmentId)).toEqual([
      'stairs_to_upper',
      'bay_to_transfer',
    ]);
    const lastProbe = reveal.probes.at(-1);
    expect(reveal.trace[0]?.delay).toBeGreaterThan(
      (lastProbe?.delay ?? 0) + (lastProbe?.duration ?? 0),
    );
    expect(reveal.total).toBe((reveal.trace.at(-1)?.delay ?? 0) + TRACE_MS);
  });
  it('draws nothing for a plan made before searches were recorded', () => {
    expect(revealSearch({ ...plan, search: [] })).toBeNull();
  });
});

describe('route ranking', () => {
  it('puts the selected route first, then the planner’s alternatives', () => {
    const [selected, second] = rankRoutes(plan, map);
    expect(selected).toEqual({
      selected: true,
      placeIds: ['inspection_bay', 'stair_transfer', 'upper_inspection'],
      transferPlaceIds: ['stair_transfer'],
      bodyIds: ['gazebo-rover', 'mujoco-go1'],
      distanceM: plan.distance_m,
    });
    expect(second?.placeIds).toEqual([
      'inspection_bay',
      'west_bypass',
      'stair_transfer',
      'upper_inspection',
    ]);
    expect(second?.bodyIds).toEqual(['gazebo-rover', 'mujoco-go1']);
    expect(second?.distanceM).toBeGreaterThan(selected?.distanceM ?? 0);
  });
  it('shows speed limits as reviewed, without single-precision noise', () => {
    expect(speed(0.30000001192092896)).toBe('0.3 m/s');
    expect(speed(0.25)).toBe('0.25 m/s');
  });
});

describe('fence timer', () => {
  const from = 0;
  const until = 30_000;
  it('empties as the fence runs and opens at the not-before time', () => {
    expect(fenceState(from, until, 0, 'This handoff')).toMatchObject({
      open: false,
      remaining: 30,
      left: 1,
    });
    expect(fenceState(from, until, 15_000, 'This handoff')).toMatchObject({
      remaining: 15,
      left: 0.5,
    });
    expect(fenceState(from, until, 29_001, 'This handoff').remaining).toBe(1);
    expect(fenceState(from, until, 30_000, 'This handoff')).toMatchObject({
      open: true,
      remaining: 0,
      left: 0,
    });
  });
  it('speaks only at ten-second marks', () => {
    const heard = new Set<string>();
    for (let now = 0; now <= until; now += 250)
      heard.add(fenceState(from, until, now, 'This handoff').announcement);
    expect(ANNOUNCE_EVERY_S).toBe(10);
    expect([...heard]).toEqual([
      'This handoff can be approved in 30 seconds or less.',
      'This handoff can be approved in 20 seconds or less.',
      'This handoff can be approved in 10 seconds or less.',
      'The execution fence has ended. This handoff can be approved.',
    ]);
  });
});

describe('audit ledger', () => {
  const record = (position: number, hash: string, previous: string | null): AuditRecord => ({
    occurred_at: new Date(position * 1000).toISOString(),
    actor: { operator: 'operator-a' },
    event_type: 'round.approved',
    object_id: `round-${position}`,
    metadata: {},
    position,
    previous_hash: previous,
    record_hash: hash,
    verified: true,
  });
  it('lists newest first and checks each link against the row below', () => {
    const rows = ledgerRows([record(1, 'aa', null), record(2, 'bb', 'aa'), record(3, 'cc', 'xx')]);
    expect(rows.map((row) => row.record.position)).toEqual([3, 2, 1]);
    expect(rows.map((row) => row.linkedBelow)).toEqual([false, true, undefined]);
  });
  it('draws no links for records from a core that does not return hashes', () => {
    const { position, previous_hash, record_hash, verified, ...plain } = record(1, 'aa', null);
    const rows = ledgerRows([plain, { ...plain, object_id: 'round-2' }]);
    expect(rows.every((row) => row.linkedBelow === undefined && row.verified === undefined)).toBe(
      true,
    );
    expect([position, previous_hash, record_hash, verified]).toEqual([1, null, 'aa', true]);
  });
});
