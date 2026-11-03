export interface Point {
  readonly x: number;
  readonly y: number;
}
export interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}
export interface Pose extends Point {
  readonly t: number;
  readonly yaw: number;
}

export const corners = (box: Box): Point[] => [
  { x: box.x0, y: box.y0 },
  { x: box.x1, y: box.y0 },
  { x: box.x1, y: box.y1 },
  { x: box.x0, y: box.y1 },
];

/** Keeps the part of a convex polygon where a·p ≤ b (one Sutherland–Hodgman pass). */
function clip(polygon: readonly Point[], ax: number, ay: number, b: number): Point[] {
  const inside = (p: Point) => ax * p.x + ay * p.y <= b + 1e-9;
  const out: Point[] = [];
  polygon.forEach((current, index) => {
    const previous = polygon[(index + polygon.length - 1) % polygon.length] as Point;
    const crossing = () => {
      const a = ax * previous.x + ay * previous.y - b,
        c = ax * current.x + ay * current.y - b;
      const s = a / (a - c);
      return {
        x: previous.x + (current.x - previous.x) * s,
        y: previous.y + (current.y - previous.y) * s,
      };
    };
    if (inside(current)) {
      if (!inside(previous)) out.push(crossing());
      out.push(current);
    } else if (inside(previous)) out.push(crossing());
  });
  return out;
}

/**
 * The region of `box` closer to `sites[index]` than to any other site. Inside it the distance to the
 * nearest place is the distance to that one site, so its circles are exact iso-distance contours.
 */
export function voronoiCell(sites: readonly Point[], index: number, box: Box): Point[] {
  const site = sites[index];
  if (!site) return [];
  return sites.reduce<Point[]>((cell, other, j) => {
    if (j === index || (other.x === site.x && other.y === site.y)) return cell;
    // |p−s|² ≤ |p−o|²  ⇔  2(o−s)·p ≤ |o|² − |s|²
    return clip(
      cell,
      2 * (other.x - site.x),
      2 * (other.y - site.y),
      other.x ** 2 + other.y ** 2 - site.x ** 2 - site.y ** 2,
    );
  }, corners(box));
}

/** Drops samples that moved less than `step` metres, so a parked body adds no vertices. */
export function simplify<T extends Point>(points: readonly T[], step = 0.03): T[] {
  const out: T[] = [];
  for (const point of points) {
    const last = out.at(-1);
    if (!last || Math.hypot(point.x - last.x, point.y - last.y) >= step) out.push(point);
  }
  const final = points.at(-1);
  if (final && out.at(-1) !== final) out.push(final);
  return out;
}

export function cumulative(points: readonly Point[]): number[] {
  let total = 0;
  return points.map((point, index) => {
    const previous = points[index - 1];
    if (previous) total += Math.hypot(point.x - previous.x, point.y - previous.y);
    return total;
  });
}

/** Position and heading at arc length `distance` along a polyline. */
export function along(
  points: readonly Point[],
  lengths: readonly number[],
  distance: number,
): Point & { angle: number; index: number } {
  const first = points[0] ?? { x: 0, y: 0 };
  let index = lengths.findIndex((length) => length >= distance);
  if (index <= 0) index = index === 0 ? 1 : points.length - 1;
  const a = points[index - 1] ?? first,
    b = points[index] ?? a;
  const start = lengths[index - 1] ?? 0,
    span = (lengths[index] ?? start) - start;
  const s = span > 0 ? Math.min(1, Math.max(0, (distance - start) / span)) : 1;
  return {
    x: a.x + (b.x - a.x) * s,
    y: a.y + (b.y - a.y) * s,
    angle: Math.atan2(b.y - a.y, b.x - a.x),
    /** The sample nearest this point along the path. */
    index: s < 0.5 ? index - 1 : index,
  };
}

/** The recorded sample in effect at time `t` (the last one at or before it). */
export function poseAt<T extends { t: number }>(poses: readonly T[], t: number): T | undefined {
  return poses.findLast((pose) => pose.t <= t) ?? poses[0];
}

/** Position and heading at time `t`, interpolated between the two recorded samples around it. */
export function sampleAt(samples: readonly Pose[], t: number): Pose | undefined {
  const hi = samples.findIndex((sample) => sample.t >= t);
  if (hi < 0) return samples.at(-1);
  if (hi === 0) return samples[0];
  const a = samples[hi - 1] as Pose,
    b = samples[hi] as Pose;
  const s = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  // Turn the short way round between the two recorded headings.
  const turn = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
  return { t, x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s, yaw: a.yaw + turn * s };
}

export interface Scan {
  readonly angle_min: number;
  readonly angle_increment: number;
  readonly range_min: number;
  readonly range_max: number;
  readonly sensor_map_pose: Pose | (Point & { yaw: number });
  readonly ranges: readonly (number | null)[];
}

/**
 * The same corridor test the ROS 2 gateway applied before it stopped the rover
 * (services/lattice-ros2-gateway/include/route_obstacle.hpp): a finite return counts when it lies
 * 0.18 m to 0.9 m ahead of the body along the reviewed segment and within 0.28 m of its centre line.
 */
export const corridor = { ahead: [0.18, 0.9], lateral: 0.28 } as const;
export function scanReturns(scan: Scan, base: Point, target: Point) {
  const distance = Math.hypot(target.x - base.x, target.y - base.y);
  const ux = (target.x - base.x) / distance,
    uy = (target.y - base.y) / distance;
  const pose = scan.sensor_map_pose;
  return scan.ranges.flatMap((range, index) => {
    if (
      range === null ||
      !Number.isFinite(range) ||
      range < scan.range_min ||
      range > scan.range_max
    )
      return [];
    const angle = pose.yaw + scan.angle_min + index * scan.angle_increment;
    const x = pose.x + range * Math.cos(angle),
      y = pose.y + range * Math.sin(angle);
    const ahead = (x - base.x) * ux + (y - base.y) * uy,
      lateral = Math.abs((x - base.x) * uy - (y - base.y) * ux);
    const hit =
      ahead >= corridor.ahead[0] &&
      ahead <= Math.min(corridor.ahead[1], distance) &&
      lateral <= corridor.lateral;
    return [{ x, y, hit, beam: index }];
  });
}

/** The corridor rectangle in map coordinates, for drawing the region the gateway tested. */
export function corridorOutline(base: Point, target: Point): Point[] {
  const distance = Math.hypot(target.x - base.x, target.y - base.y);
  const ux = (target.x - base.x) / distance,
    uy = (target.y - base.y) / distance;
  const near = corridor.ahead[0],
    far = Math.min(corridor.ahead[1], distance),
    w = corridor.lateral;
  const at = (a: number, l: number) => ({
    x: base.x + ux * a - uy * l,
    y: base.y + uy * a + ux * l,
  });
  return [at(near, -w), at(far, -w), at(far, w), at(near, w)];
}
