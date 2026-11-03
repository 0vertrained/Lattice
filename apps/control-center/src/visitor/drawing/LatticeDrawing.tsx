import { type ReactNode, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { along, cumulative, type Point, poseAt, simplify, voronoiCell } from './geometry';
import { markPose, type Scene } from './scenes';

/** Drawing units per metre: the drafting grid's 8-unit minor and 64-unit major lines are ⅛ m and 1 m. */
const K = 64;
const PAD = 30;
const r1 = (n: number) => Math.round(n * 10) / 10;
const deg = (radians: number) => r1((radians * 180) / Math.PI);
const segment = (a: Point, b: Point) => `M${r1(a.x)} ${r1(a.y)}L${r1(b.x)} ${r1(b.y)}`;
const polyline = (points: readonly Point[]) =>
  points.length ? `M${points.map((p) => `${r1(p.x)} ${r1(p.y)}`).join('L')}` : '';
const polygon = (points: readonly Point[]) => points.map((p) => `${r1(p.x)},${r1(p.y)}`).join(' ');
const ring = (c: Point, r: number) =>
  `M${r1(c.x - r)} ${r1(c.y)}a${r1(r)} ${r1(r)} 0 1 0 ${r1(2 * r)} 0a${r1(r)} ${r1(r)} 0 1 0 ${r1(-2 * r)} 0`;
const placed = (at: Point, angle: number) =>
  `translate(${r1(at.x)} ${r1(at.y)}) rotate(${r1(angle)})`;
/** A wedge from the origin that opens anticlockwise, in the scan's beam order. */
const wedge = (c: Point, from: number, sweep: number) => {
  const count = Math.max(2, Math.ceil(sweep / 0.1));
  const rim = Array.from({ length: count + 1 }, (_, i) => {
    const a = from + (sweep * i) / count;
    return `${r1(c.x + 2000 * Math.cos(a))} ${r1(c.y - 2000 * Math.sin(a))}`;
  });
  return `M${r1(c.x)} ${r1(c.y)}L${rim.join('L')}Z`;
};

function layout(scene: Scene) {
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
    const mid = {
      x: (a.x + c.x) / 2 + Math.sin(angle) * 19,
      y: (a.y + c.y) / 2 - Math.cos(angle) * 19,
    };
    return {
      ...lane,
      a,
      c,
      mid,
      d: segment(a, c),
      size: Math.hypot(c.x - a.x, c.y - a.y),
      dim: placed(mid, (angle * 180) / Math.PI),
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
  const tracks = scene.tracks.map((track) => {
    const points = track.poses.map(to);
    const lengths = cumulative(points);
    return { ...track, points, lengths, total: lengths.at(-1) ?? 0, d: polyline(points) };
  });
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
    to,
    width,
    height,
    contours,
    places,
    lanes,
    tracks,
    marks,
    scan:
      scan && origin
        ? {
            origin,
            start: scan.start,
            hits: scan.hits,
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
  };
}

type View = ReturnType<typeof layout>;
/** A body glyph at a point along its path, turned to the heading recorded there (bodies can reverse). */
const facing = (track: View['tracks'][number], share: number) => {
  const at = along(track.points, track.lengths, share * track.total);
  return placed(at, -deg(track.poses[at.index]?.yaw ?? 0));
};
interface Step {
  readonly start: number;
  readonly end: number;
  readonly key: string;
  readonly kind: 'pen' | 'fade' | 'sweep' | 'track';
  readonly track?: number;
}

/** One pass at a steady pen speed: the map, the measured condition, the reviewed change, then motion. */
function timeline(view: View): Step[] {
  const steps: Step[] = [
    { start: 0, end: 400, key: 'solid', kind: 'fade' },
    { start: 0, end: 400, key: 'grid', kind: 'fade' },
  ];
  const strokes = [
    ...view.lanes.map((lane, i) => ({ key: `lane-${i}`, length: lane.size, after: `dim-${i}` })),
    ...view.places.map((place, i) => ({
      key: `place-${i}`,
      length: 2 * Math.PI * place.r + 4 * place.r + 32,
      after: `label-${i}`,
    })),
    ...(view.stairs ? [{ key: 'stairs', length: 384, after: 'stairs-label' }] : []),
  ];
  const total = strokes.reduce((sum, stroke) => sum + stroke.length, 0) || 1;
  let t = 300;
  for (const stroke of strokes) {
    const span = (stroke.length / total) * 2300;
    steps.push({ start: t, end: t + span, key: stroke.key, kind: 'pen' });
    steps.push({ start: t + span, end: t + span + 220, key: stroke.after, kind: 'fade' });
    t += span;
  }
  t += 250;
  if (view.scan) {
    steps.push({ start: t, end: t + 1000, key: 'scan', kind: 'sweep' });
    t += 1000;
    steps.push({ start: t, end: t + 250, key: 'corridor', kind: 'fade' });
    steps.push({ start: t, end: t + 250, key: 'barrier', kind: 'fade' });
    t += 250;
    steps.push({ start: t, end: t + 200, key: 'blocked', kind: 'pen' });
    t += 350;
    steps.push({ start: t, end: t + 700, key: 'replanned', kind: 'pen' });
    t += 800;
  }
  steps.push({ start: t, end: t + 250, key: 'body', kind: 'fade' });
  view.tracks.forEach((track, i) => {
    const span = Math.min(2600, Math.max(900, (track.total / K) * 260));
    steps.push({ start: t, end: t + span, key: `track-${i}`, kind: 'track', track: i });
    view.marks.forEach((mark, m) => {
      if (mark.track === i)
        steps.push({
          start: t + mark.share * span,
          end: t + mark.share * span + 200,
          key: `mark-${m}`,
          kind: 'fade',
        });
    });
    t += span + 150;
  });
  return steps;
}

export function LatticeDrawing({
  scene,
  label,
  mode,
  time = 0,
  run = 0,
}: {
  readonly scene: Scene;
  readonly label: string;
  /** 'plot' draws the scene once when it appears; 'replay' shows the recording at `time`. */
  readonly mode: 'plot' | 'replay';
  readonly time?: number;
  /** Changing this plots the drawing again. */
  readonly run?: number;
}) {
  const id = useId().replaceAll(':', '');
  const svg = useRef<SVGSVGElement>(null);
  const view = useMemo(() => layout(scene), [scene]);
  const replay = mode === 'replay';

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing `run` plots the drawing again.
  useLayoutEffect(() => {
    const root = svg.current;
    if (!root || replay || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const steps = timeline(view);
    const nodes = new Map(
      steps.map((step) => [
        step.key,
        [...root.querySelectorAll<SVGElement>(`[data-k="${step.key}"]`)],
      ]),
    );
    const sweep = root.querySelector<SVGPathElement>(`#${id}-sweep path`);
    const glyphs = [...root.querySelectorAll<SVGGElement>('[data-glyph]')];
    const full = sweep?.getAttribute('d') ?? '';
    const finalPlace = (i: number) => {
      const track = view.tracks[i];
      if (track) glyphs[i]?.setAttribute('transform', facing(track, 1));
    };
    const apply = (step: Step, p: number) => {
      for (const node of nodes.get(step.key) ?? []) {
        if (step.kind === 'fade') node.style.opacity = String(p);
        else if (step.kind !== 'sweep') node.style.strokeDashoffset = String(1 - p);
      }
      if (step.kind === 'sweep' && sweep && view.scan)
        sweep.setAttribute(
          'd',
          p >= 1 ? full : wedge(view.scan.origin, view.scan.start, p * 2 * Math.PI),
        );
      if (step.kind === 'track' && step.track !== undefined) {
        const track = view.tracks[step.track];
        if (track) glyphs[step.track]?.setAttribute('transform', facing(track, p));
      }
    };
    root.dataset.plotting = '';
    for (const step of steps) apply(step, 0);
    const end = Math.max(...steps.map((step) => step.end));
    let clock = 0,
      last = performance.now(),
      visible = true,
      frame = 0;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
    });
    observer.observe(root);
    const finish = () => {
      delete root.dataset.plotting;
      for (const list of nodes.values())
        for (const node of list) {
          node.style.removeProperty('opacity');
          node.style.removeProperty('stroke-dashoffset');
        }
      sweep?.setAttribute('d', full);
      glyphs.forEach((_, i) => {
        finalPlace(i);
      });
    };
    const tick = (now: number) => {
      // Pauses while scrolled away; a long gap (a background tab) resumes rather than jumps.
      if (visible) clock += Math.min(50, now - last);
      last = now;
      for (const step of steps)
        apply(step, Math.min(1, Math.max(0, (clock - step.start) / (step.end - step.start))));
      if (clock < end) frame = requestAnimationFrame(tick);
      else finish();
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      finish();
    };
  }, [view, replay, run, id]);

  const statics = useMemo(
    () => (
      <>
        <defs>
          <pattern
            id={`${id}-grid`}
            width={K}
            height={K}
            patternUnits="userSpaceOnUse"
            x={r1(view.origin.x)}
            y={r1(view.origin.y)}
          >
            <path
              className="d-minor"
              d="M8 0V64M16 0V64M24 0V64M32 0V64M40 0V64M48 0V64M56 0V64M0 8H64M0 16H64M0 24H64M0 32H64M0 40H64M0 48H64M0 56H64"
            />
            <path className="d-major" d="M0 0V64M0 0H64" />
          </pattern>
          {(['stop', 'hold'] as const).map((tone) => (
            <pattern
              key={tone}
              id={`${id}-${tone}`}
              width="7"
              height="7"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect className="d-hatch-ground" width="7" height="7" />
              <path className={`d-hatch-${tone}`} d="M0 0V7" />
            </pattern>
          ))}
          {view.contours.map((contour, i) => (
            <clipPath key={contour.cell} id={`${id}-cell-${i}`}>
              <polygon points={contour.cell} />
            </clipPath>
          ))}
          {view.scan && (
            <clipPath id={`${id}-sweep`}>
              <path d={wedge(view.scan.origin, 0, 2 * Math.PI)} />
            </clipPath>
          )}
        </defs>
        <rect className="d-film" width={view.width} height={view.height} />
        <rect
          data-k="grid"
          fill={`url(#${id}-grid)`}
          x={PAD}
          y={PAD}
          width={view.width - 2 * PAD}
          height={view.height - 2 * PAD}
        />
        <g className="d-contours">
          {view.contours.map((contour, i) => (
            <g key={contour.cell} clipPath={`url(#${id}-cell-${i})`}>
              {contour.radii.map((radius) => (
                <circle
                  key={radius}
                  cx={r1(contour.centre.x)}
                  cy={r1(contour.centre.y)}
                  r={radius}
                />
              ))}
            </g>
          ))}
        </g>
        {scene.solids.map((solid) => {
          const a = view.to({ x: solid.box.x0, y: solid.box.y1 }),
            c = view.to({ x: solid.box.x1, y: solid.box.y0 });
          const barrier = solid.kind === 'barrier';
          return (
            <rect
              key={`${solid.kind}-${r1(a.x)}-${r1(a.y)}`}
              data-k={barrier ? 'barrier' : 'solid'}
              className={`d-${solid.kind}`}
              fill={barrier ? `url(#${id}-stop)` : undefined}
              x={r1(a.x)}
              y={r1(a.y)}
              width={r1(c.x - a.x)}
              height={r1(c.y - a.y)}
            >
              <title>
                {barrier
                  ? 'Barrier placed after the route was approved'
                  : solid.kind === 'shelf'
                    ? 'Occupied shelf'
                    : 'Warehouse wall'}
              </title>
            </rect>
          );
        })}
        {view.stairs?.risers.map((d) => (
          <path key={d} data-k="stairs" data-pen="" pathLength={1} className="d-riser" d={d} />
        ))}
        {view.stairs && (
          <text
            data-k="stairs-label"
            className="d-note"
            x={r1(view.stairs.label.x)}
            y={r1(view.stairs.label.y + 17)}
          >
            MuJoCo stairs
          </text>
        )}
        {view.lanes.map((lane, i) => (
          <g key={lane.id} className="d-lane">
            <title>
              {`${lane.id.replaceAll('_', ' ')}: ${
                lane.blocked
                  ? 'closed by a measured blockage'
                  : lane.replanned
                    ? 'added by the reviewed replan'
                    : lane.planned
                      ? 'in the approved route'
                      : 'available'
              }`}
            </title>
            <path
              data-k={`lane-${i}`}
              data-pen=""
              pathLength={1}
              className="d-lane-edge"
              d={lane.d}
            />
            <path
              data-k={`lane-${i}`}
              data-pen=""
              pathLength={1}
              className="d-lane-core"
              d={lane.d}
            />
            {(lane.planned || lane.replanned) && (
              <path
                data-k={lane.replanned ? 'replanned' : `lane-${i}`}
                data-pen=""
                pathLength={1}
                className="d-lane-fill"
                d={lane.d}
              />
            )}
            {lane.blocked && (
              <path
                data-k="blocked"
                data-pen=""
                pathLength={1}
                className="d-lane-block"
                stroke={`url(#${id}-stop)`}
                d={lane.d}
              />
            )}
            <text data-k={`dim-${i}`} className="d-dim" transform={lane.dim} textAnchor="middle">
              {`${lane.length.toFixed(2)} m`}
            </text>
          </g>
        ))}
        {view.scan && (
          <>
            <g data-k="scan" className="d-scan" clipPath={replay ? undefined : `url(#${id}-sweep)`}>
              <path className="d-ray" d={view.scan.rays} />
              <path className="d-ray d-hit" d={view.scan.hitRays} />
              <path className="d-return" d={view.scan.returns} />
              <path className="d-return d-hit" d={view.scan.hitReturns} />
            </g>
            <polygon data-k="corridor" className="d-corridor" points={view.scan.corridor}>
              <title>{`Route corridor the gateway tested: ${view.scan.hits} laser returns inside it`}</title>
            </polygon>
          </>
        )}
        {view.places.map((place, i) => (
          <g key={place.id}>
            <path
              data-k={`place-${i}`}
              data-pen=""
              pathLength={1}
              className="d-place"
              d={`${ring(place.svg, place.r)}M${r1(place.svg.x - place.r - 8)} ${r1(place.svg.y)}h${r1(2 * place.r + 16)}M${r1(place.svg.x)} ${r1(place.svg.y - place.r - 8)}v${r1(2 * place.r + 16)}`}
            />
            <text
              data-k={`label-${i}`}
              className="d-label"
              x={r1(place.spot.x)}
              y={r1(place.spot.y)}
              textAnchor={place.spot.anchor}
            >
              {place.label}
            </text>
          </g>
        ))}
        <g
          className="d-axis"
          transform={`translate(${r1(view.scale.x + 8)} ${r1(view.scale.y - 30)})`}
        >
          <path d="M0 0H32M26 -4L32 0L26 4M0 0V-32M-4 -26L0 -32L4 -26" />
          <text className="d-note" x="38" y="4">
            x
          </text>
          <text className="d-note" x="-3" y="-38">
            y
          </text>
        </g>
        <g className="d-scale" transform={`translate(${r1(view.scale.x)} ${r1(view.scale.y)})`}>
          <path d="M0 -5V0H64V-5M32 -3V0" />
          <text className="d-note" x="72" y="1">
            1 m
          </text>
        </g>
      </>
    ),
    [view, scene.solids, id, replay],
  );

  const shown = (t: number) => !replay || t <= time;
  const glyph = (tone: string, i: number, transform: string): ReactNode => (
    <g
      key={`glyph-${tone}-${i}`}
      data-glyph=""
      data-k="body"
      className={`d-glyph d-${tone}`}
      transform={transform}
    >
      <path d="M12 0L-8 -8L-4 0L-8 8Z" />
    </g>
  );
  return (
    <svg
      ref={svg}
      className="lattice-drawing"
      viewBox={`0 0 ${view.width} ${view.height}`}
      role="img"
      aria-label={label}
    >
      {statics}
      {view.tracks.map((track, i) => {
        if (!replay)
          return (
            <g key={track.id} className={`d-${track.tone}`}>
              <path
                data-k={`track-${i}`}
                data-pen=""
                pathLength={1}
                className="d-casing"
                d={track.d}
              />
              <path
                data-k={`track-${i}`}
                data-pen=""
                pathLength={1}
                className="d-track"
                d={track.d}
              />
            </g>
          );
        const played = polyline(track.poses.filter((pose) => pose.t <= time).map(view.to));
        return (
          <g key={track.id} className={`d-${track.tone}`}>
            <path className="d-track-ahead" d={track.d} />
            {played && <path className="d-casing" d={played} />}
            {played && <path className="d-track" d={played} />}
          </g>
        );
      })}
      {view.marks.map((mark, m) =>
        shown(mark.t) ? (
          <g
            key={`${mark.kind}-${mark.t}`}
            data-k={`mark-${m}`}
            className={`d-mark d-${mark.kind}`}
            transform={mark.transform}
          >
            <title>{mark.label}</title>
            {mark.kind === 'stop' ? (
              <path d="M0 -15V15" />
            ) : (
              <rect
                x="-8"
                y="-8"
                width="16"
                height="16"
                transform={mark.kind === 'hold' ? 'rotate(45)' : undefined}
                fill={mark.kind === 'hold' ? `url(#${id}-hold)` : undefined}
              />
            )}
          </g>
        ) : null,
      )}
      {view.tracks.map((track, i) => {
        if (!replay) {
          return glyph(track.tone, i, facing(track, 1));
        }
        const pose = poseAt(track.samples, time);
        return pose ? glyph(track.tone, i, placed(view.to(pose), -deg(pose.yaw))) : null;
      })}
    </svg>
  );
}
