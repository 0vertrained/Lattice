import { describe, expect, it } from 'vitest';
import scanJson from '../../../public/demo/adaptive-blockage-scan.json';
import adaptiveJson from '../../../public/demo/adaptive-route.json';
import walkthroughJson from '../../../public/demo/walkthrough.json';
import { adaptiveRecordingSchema } from '../adaptiveTypes';
import type { Walkthrough } from '../types';
import { along, cumulative, type Scan, scanReturns, simplify, voronoiCell } from './geometry';
import { adaptiveScene, markPose, singleScene } from './scenes';

const recorded = {
  'adaptive-route.json': adaptiveJson,
  'adaptive-blockage-scan.json': scanJson,
  'walkthrough.json': walkthroughJson,
} as const;
const demo = (file: keyof typeof recorded): unknown => recorded[file];

describe('drawing geometry', () => {
  it('keeps the part of the map nearer one place than any other', () => {
    const box = { x0: -2, y0: -1, x1: 2, y1: 1 };
    const cell = voronoiCell(
      [
        { x: -1, y: 0 },
        { x: 1, y: 0 },
      ],
      0,
      box,
    );
    expect(Math.max(...cell.map((p) => p.x))).toBeCloseTo(0);
    expect(Math.min(...cell.map((p) => p.x))).toBeCloseTo(-2);
  });

  it('walks a path by arc length and ignores samples where the body stood still', () => {
    const path = simplify([
      { x: 0, y: 0 },
      { x: 0.01, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
    expect(path).toHaveLength(3);
    const lengths = cumulative(path);
    expect(lengths.at(-1)).toBeCloseTo(2);
    const halfway = along(path, lengths, 1.5);
    expect(halfway.x).toBeCloseTo(1);
    expect(halfway.y).toBeCloseTo(0.5);
    expect(halfway.angle).toBeCloseTo(Math.PI / 2);
  });

  it('finds the same blocking returns the gateway reported for the recorded scan', () => {
    const run = adaptiveRecordingSchema.parse(demo('adaptive-route.json'));
    const scan = demo('adaptive-blockage-scan.json') as Scan;
    const evidence = run.condition_observation.evidence;
    const target = run.map.places.find((place) => place.id === 'stair_transfer')?.pose;
    if (!evidence || !target) throw new Error('fixture is missing the blockage evidence');
    const hits = scanReturns(scan, evidence.observer_pose, target).filter((ray) => ray.hit);
    expect(hits).toHaveLength(evidence.blocked_samples);
    const nearest = Math.min(
      ...hits.map((ray) =>
        Math.hypot(ray.x - evidence.observer_pose.x, ray.y - evidence.observer_pose.y),
      ),
    );
    expect(nearest).toBeCloseTo(evidence.distance_m, 6);
  });
});

describe('story scenes', () => {
  it('draws the closed aisle, the reviewed detour and both bodies for the adaptive run', () => {
    const run = adaptiveRecordingSchema.parse(demo('adaptive-route.json'));
    const scene = adaptiveScene(run, demo('adaptive-blockage-scan.json') as Scan);
    const lane = (id: string) => scene.lanes.find((item) => item.id === id);
    expect(lane('bay_to_transfer')).toMatchObject({ planned: true, blocked: true });
    expect(lane('bay_to_west_bypass')).toMatchObject({ replanned: true, blocked: false });
    expect(lane('west_bypass_to_transfer')).toMatchObject({ replanned: true });
    expect(lane('stairs_to_upper')).toMatchObject({ planned: true, replanned: false });
    expect(scene.tracks.map((track) => track.label)).toEqual(['Gazebo rover', 'MuJoCo Go1']);
    expect(scene.scan?.hits).toBe(run.condition_observation.evidence?.blocked_samples);
    expect(scene.solids.filter((solid) => solid.kind === 'barrier')).toHaveLength(1);
  });

  it('marks the missing marker and the core interruption where the rover was at those times', () => {
    const run = demo('walkthrough.json') as Walkthrough;
    const scene = singleScene(run);
    expect(scene.marks.map((mark) => mark.kind)).toEqual(['hold', 'stop']);
    const anomaly = scene.marks[0];
    const pose = anomaly && markPose(scene, anomaly);
    // The anomaly is recorded at the loading dock (3.5, 0).
    expect(pose && Math.hypot(pose.x - 3.5, pose.y)).toBeLessThan(0.6);
    expect(scene.tracks[0]?.samples).toHaveLength(run.poses.length);
  });
});
