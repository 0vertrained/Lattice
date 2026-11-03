import { cumulative, type Point, simplify, voronoiCell } from './geometry';
import { markPose, type Scene } from './scenes';
import { searchRoute } from './search';

/** Drawing units per metre: the drafting grid's 8-unit minor and 64-unit major lines are ⅛ m and 1 m. */
export const K = 64;
export const PAD = 30;
export const r1 = (n: number) => Math.round(n * 10) / 10;
export const deg = (radians: number) => r1((radians * 180) / Math.PI);
export const segment = (a: Point, b: Point) => `M${r1(a.x)} ${r1(a.y)}L${r1(b.x)} ${r1(b.y)}`;
export const polyline = (points: readonly Point[]) =>
  points.length ? `M${points.map((p) => `${r1(p.x)} ${r1(p.y)}`).join('L')}` : '';
export const polygon = (points: readonly Point[]) =>
  points.map((p) => `${r1(p.x)},${r1(p.y)}`).join(' ');
export const ring = (c: Point, r: number) =>
  `M${r1(c.x - r)} ${r1(c.y)}a${r1(r)} ${r1(r)} 0 1 0 ${r1(2 * r)} 0a${r1(r)} ${r1(r)} 0 1 0 ${r1(-2 * r)} 0`;
export const placed = (at: Point, angle: number) =>
  `translate(${r1(at.x)} ${r1(at.y)}) rotate(${r1(angle)})`;
/** A wedge from the origin that opens anticlockwise, in the scan's beam order. */
export const wedge = (c: Point, from: number, sweep: number, radius = 2000) => {
  const count = Math.max(2, Math.ceil(sweep / 0.1));
  const rim = Array.from({ length: count + 1 }, (_, i) => {
    const a = from + (sweep * i) / count;
    return `${r1(c.x + radius * Math.cos(a))} ${r1(c.y - radius * Math.sin(a))}`;
  });
  return `M${r1(c.x)} ${r1(c.y)}L${rim.join('L')}Z`;
};

export function layout(scene: Scene) {
  const b = scene.bounds;
  const to = (p: Point): Point => ({ x: PAD + (p.x - b.x0) * K, y: PAD + (b.y1 - p.y) * K });
  const width = r1((b.x1 - b.x0) * K + 2 * PAD),
    height = r1((b.y1 - b.y0) * K + 2 * PAD);
  const sites = scene.places.map((place) => place.at);
  const centre = {
    x: sites.reduce((sum, p) => sum + p.x, 0) / Math.max(1, sites.length),
    y: sites.reduce((sum, p) => sum + p.y, 0) / Math.max(1, sites.length),
  };
  const contours = sites.map((site, index) => {
    const cell = voronoiCell(sites, index, b);
    const reach = Math.max(0, ...cell.map((p) => Math.hypot(p.x - site.x, p.y - site.y)));
    return {
      cell: polygon(cell.map(to)),
      centre: to(site),
      radii: Array.from({ length: Math.floor(reach / 0.5) }, (_, i) => (i + 1) * 0.5 * K),
    };
  });
  const lanes = scene.lanes.map((lane) => {
    const a = to(lane.from),
      c = to(lane.to);
    let angle = Math.atan2(c.y - a.y, c.x - a.x);
    if (angle > Math.PI / 2) angle -= Math.PI;
    if (angle <= -Math.PI / 2) angle += Math.PI;
    const side = (sign: number) => ({
      x: (a.x + c.x) / 2 + sign * Math.sin(angle) * 19,
      y: (a.y + c.y) / 2 - sign * Math.cos(angle) * 19,
    });
    const mid = side(1);
    return {
      ...lane,
      a,
      c,
      mid,
      other: side(-1),
      turn: (angle * 180) / Math.PI,
      d: segment(a, c),
      size: Math.hypot(c.x - a.x, c.y - a.y),
    };
  });
  // Place labels where they cost least: inside the frame, off the lanes and their dimensions, clear of
  // other labels, preferring the side away from the other places. Sized for the larger phone text.
  const inner = { x0: PAD + 14, x1: width - PAD - 14, y0: PAD + 14, y1: height - PAD - 14 };
  const obstacles = lanes.flatMap((lane) => [
    ...Array.from({ length: Math.ceil(lane.size / 10) + 1 }, (_, i) => {
      const s = Math.min(1, (i * 10) / lane.size);
      return { x: lane.a.x + (lane.c.x - lane.a.x) * s, y: lane.a.y + (lane.c.y - lane.a.y) * s };
    }),
    lane.mid,
  ]);
  // Shelves and barriers count as much as lanes; recorded paths count less.
  for (const solid of scene.solids) {
    if (solid.kind === 'wall') continue;
    const a = to({ x: solid.box.x0, y: solid.box.y1 }),
      c = to({ x: solid.box.x1, y: solid.box.y0 });
    for (let x = a.x; x <= c.x; x += 10)
      for (let y = a.y; y <= c.y; y += 10) obstacles.push({ x, y });
  }
  const paths = scene.tracks.flatMap((track) => simplify(track.poses.map(to), 12));
  type Spot = { x: number; y: number; anchor: 'start' | 'end' | 'middle' };
  type Extent = { x0: number; x1: number; y0: number; y1: number };
  const extent = (spot: Spot, w: number): Extent => {
    const x0 =
      spot.anchor === 'start' ? spot.x : spot.anchor === 'end' ? spot.x - w : spot.x - w / 2;
    return { x0, x1: x0 + w, y0: spot.y - 26, y1: spot.y + 7 };
  };
  const overlap = (a: Extent, b: Extent) =>
    Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) *
    Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const taken: Extent[] = [];
  const places = scene.places.map((place) => {
    const at = to(place.at),
      r = (place.radius ?? 0.3) * K,
      w = place.label.length * 12.5;
    const dx = place.at.x - centre.x,
      dy = place.at.y - centre.y;
    const vertical = (above: boolean): Spot => {
      const y = above ? at.y - r - 11 : at.y + r + 25;
      if (at.x + w / 2 > inner.x1) return { x: at.x + r, y, anchor: 'end' };
      if (at.x - w / 2 < inner.x0) return { x: at.x - r, y, anchor: 'start' };
      return { x: at.x, y, anchor: 'middle' };
    };
    const right: Spot = { x: at.x + r + 10, y: at.y + 5, anchor: 'start' };
    const left: Spot = { x: at.x - r - 10, y: at.y + 5, anchor: 'end' };
    const sides = dx >= 0 ? [right, left] : [left, right];
    const ends = dy >= 0 ? [vertical(true), vertical(false)] : [vertical(false), vertical(true)];
    const candidates = Math.abs(dx) > Math.abs(dy) ? [...sides, ...ends] : [...ends, ...sides];
    const cost = (spot: Spot, order: number) => {
      const box = extent(spot, w);
      const outside =
        box.x0 < inner.x0 || box.x1 > inner.x1 || box.y0 < inner.y0 || box.y1 > inner.y1;
      const blocked = obstacles.filter(
        (p) => p.x > box.x0 - 6 && p.x < box.x1 + 6 && p.y > box.y0 - 6 && p.y < box.y1 + 6,
      ).length;
      const crossed = paths.filter(
        (p) => p.x > box.x0 && p.x < box.x1 && p.y > box.y0 && p.y < box.y1,
      ).length;
      return (
        (outside ? 1e6 : 0) +
        taken.reduce((sum, other) => sum + overlap(box, other), 0) +
        blocked * 400 +
        crossed * 120 +
        order * 60
      );
    };
    const spot =
      candidates
        .map((candidate, order) => ({ candidate, score: cost(candidate, order) }))
        .sort((a, b) => a.score - b.score)[0]?.candidate ?? right;
    taken.push(extent(spot, w));
    return { ...place, svg: at, r, spot };
  });
  // A lane's length sits beside it, on the other side if a place name is there, or not at all.
  const free = (p: Point) =>
    !taken.some(
      (box) => p.x > box.x0 - 26 && p.x < box.x1 + 26 && p.y > box.y0 - 8 && p.y < box.y1 + 8,
    );
  const dims = lanes.map((lane) => {
    const at = free(lane.mid) ? lane.mid : free(lane.other) ? lane.other : null;
    return at && placed(at, lane.turn);
  });
  const tracks = scene.tracks.map((track) => {
    const points = track.poses.map(to);
    const lengths = cumulative(points);
    // Every recorded sample in drawing space, for the replay loop.
    const live = track.samples.map((sample) => ({ ...to(sample), t: sample.t, yaw: sample.yaw }));
    return { ...track, points, lengths, live, total: lengths.at(-1) ?? 0, d: polyline(points) };
  });
  const search = searchRoute(scene);
  const marks = scene.marks.flatMap((mark) => {
    const pose = markPose(scene, mark),
      track = tracks[mark.track];
    if (!pose || !track) return [];
    const index = Math.max(
      0,
      track.poses.findLastIndex((sample) => sample.t <= mark.t),
    );
    const share = track.total ? (track.lengths[index] ?? 0) / track.total : 1;
    return [{ ...mark, transform: placed(to(pose), -deg(pose.yaw)), share }];
  });
  const scan = scene.scan;
  const origin = scan ? to(scan.origin) : null;
  const rays = (hit: boolean, ends: boolean) =>
    scan && origin
      ? scan.rays
          .filter((ray) => ray.hit === hit)
          .map((ray) => {
            const end = to(ray);
            return ends ? `M${r1(end.x)} ${r1(end.y)}h0` : segment(origin, end);
          })
          .join('')
      : '';
  const stairs = scene.stairs;
  return {
    story: scene.story,
    to,
    width,
    height,
    contours,
    places,
    lanes: lanes.map((lane, i) => ({ ...lane, dim: dims[i] ?? null })),
    tracks,
    marks,
    scan:
      scan && origin
        ? {
            origin,
            start: scan.start,
            hits: scan.hits,
            // Where in the sweep the beam reaches the corridor returns (median blocking beam).
            detect: (() => {
              const beams = scan.rays.filter((ray) => ray.hit).map((ray) => ray.beam);
              return (beams[Math.floor(beams.length / 2)] ?? 0) / Math.max(1, scan.beams);
            })(),
            reach: Math.max(
              ...scan.rays.map((ray) => Math.hypot(to(ray).x - origin.x, to(ray).y - origin.y)),
            ),
            barrier: (() => {
              const solid = scene.solids.find((item) => item.kind === 'barrier');
              return solid
                ? to({ x: (solid.box.x0 + solid.box.x1) / 2, y: (solid.box.y0 + solid.box.y1) / 2 })
                : origin;
            })(),
            corridor: polygon(scan.corridor.map(to)),
            rays: rays(false, false),
            hitRays: rays(true, false),
            returns: rays(false, true),
            hitReturns: rays(true, true),
          }
        : null,
    stairs: stairs
      ? {
          risers: stairs.risers.map((x) =>
            segment(to({ x, y: stairs.y1 }), to({ x, y: stairs.y0 })),
          ),
          label: to({ x: stairs.risers[0] ?? 0, y: stairs.y0 }),
        }
      : null,
    origin: to({ x: 0, y: 0 }),
    scale: to({ x: b.x0 + 0.55, y: b.y0 + 0.45 }),
    /** Map coordinates of a drawing point, for the measuring crosshair. */
    toMap: (p: Point): Point => ({ x: b.x0 + (p.x - PAD) / K, y: b.y1 - (p.y - PAD) / K }),
    inner: { x0: PAD + 13, y0: PAD + 13, x1: width - PAD - 13, y1: height - PAD - 13 },
    search: search && {
      ...search,
      // Distance labels sit under each settled place's name.
      costs: places.flatMap((place) => {
        const distance = search.reach.get(place.id);
        return distance === undefined || distance === 0
          ? []
          : [
              {
                place: place.id,
                distance,
                x: place.spot.x,
                y: place.spot.y + 17,
                anchor: place.spot.anchor,
              },
            ];
      }),
    },
  };
}

export type View = ReturnType<typeof layout>;
