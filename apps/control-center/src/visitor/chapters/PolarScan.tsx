import { type CSSProperties, useMemo } from 'react';
import { corridorOutline, type Point, type Scan, scanReturns } from '../drawing/geometry';

// Whole scan to 8 m; the detail view enlarges the first 1.1 m, where the gateway tested the route.
const FULL = { reach: 8, scale: 36, rings: [2, 4, 6, 8] } as const;
const DETAIL = { reach: 1.1, scale: 260, rings: [0.25, 0.5, 0.75, 1] } as const;
const r1 = (value: number) => Math.round(value * 10) / 10;

interface View {
  readonly reach: number;
  readonly scale: number;
  readonly rings: readonly number[];
}

/**
 * The recorded lidar scan as a plan-position plot centred on the sensor and turned so the reviewed
 * route points up, with an enlarged detail of the corridor the gateway tested along it. Returns
 * inside the corridor are red; the arrow marks the way the rover itself was facing.
 */
export function PolarScan({
  scan,
  base,
  target,
  targetLabel,
  hits,
  nearest,
}: {
  readonly scan: Scan;
  /** Body pose the gateway tested the corridor from. */
  readonly base: Point;
  /** Far end of the reviewed segment. */
  readonly target: Point;
  readonly targetLabel: string;
  readonly hits: number;
  readonly nearest: number;
}) {
  const drawn = useMemo(() => {
    const pose = scan.sensor_map_pose;
    const route = Math.atan2(target.y - base.y, target.x - base.x);
    const c = Math.cos(-route),
      s = Math.sin(-route);
    // Along the route is up and its left is left.
    const local = (p: Point) => {
      const dx = p.x - pose.x,
        dy = p.y - pose.y;
      const ahead = dx * c - dy * s,
        left = dx * s + dy * c;
      return { x: -left, y: -ahead };
    };
    const returns = scanReturns(scan, base, target).map((ray) => ({ ...ray, at: local(ray) }));
    // The gateway measured distance from the body's pose, which sits a little behind the sensor.
    const from = (ray: { x: number; y: number }) => Math.hypot(ray.x - base.x, ray.y - base.y);
    const nearest = returns
      .filter((ray) => ray.hit)
      .reduce<(typeof returns)[number] | null>(
        (best, ray) => (!best || from(ray) < from(best) ? ray : best),
        null,
      );
    return {
      returns,
      corridor: corridorOutline(base, target).map(local),
      target: local(target),
      body: local(base),
      nearest: nearest && { at: nearest.at, distance: from(nearest) },
      // Screen rotation of the rover's heading relative to the route, in degrees.
      heading: r1((-(pose.yaw - route) * 180) / Math.PI),
    };
  }, [scan, base, target]);
  const plot = (view: View, detail: boolean) => {
    const R = view.reach * view.scale;
    const at = (p: Point) => ({ x: r1(p.x * view.scale), y: r1(p.y * view.scale) });
    const clip = (p: Point) => {
      const d = Math.hypot(p.x, p.y);
      return d > view.reach ? { x: (p.x / d) * view.reach, y: (p.y / d) * view.reach } : p;
    };
    const routeEnd = at(clip(drawn.target));
    const body = at(drawn.body);
    const pad = detail ? 34 : 46;
    return (
      <svg
        data-view={detail ? 'detail' : 'full'}
        viewBox={`${-R - pad} ${-R - pad} ${2 * R + 2 * pad} ${2 * R + 2 * pad}`}
        role="img"
        aria-label={
          detail
            ? `Detail of the route corridor ahead of the rover: ${hits} returns inside it, the nearest ${nearest.toFixed(2)} m from the rover`
            : `Recorded lidar scan around the rover, ${drawn.returns.length} returns out to ${view.reach} m, with ${hits} inside the route corridor`
        }
      >
        <defs>
          <clipPath id={detail ? 'polar-detail-clip' : 'polar-full-clip'}>
            <circle r={R} />
          </clipPath>
        </defs>
        <circle className="polar-ground" r={R} />
        {view.rings.map((ring) => (
          <g key={ring} className="polar-ring">
            <circle r={ring * view.scale} />
            {/* Ring values run down the lower right, clear of the route and the corridor. */}
            <text
              x={r1(ring * view.scale * Math.SQRT1_2) + 5}
              y={r1(ring * view.scale * Math.SQRT1_2) + 14}
            >
              {ring < 1 ? `${ring * 100} cm` : `${ring} m`}
            </text>
          </g>
        ))}
        <path
          className="polar-bearings"
          d={Array.from({ length: 12 }, (_, i) => {
            const a = (i * Math.PI) / 6;
            return `M${r1(Math.sin(a) * R)} ${r1(-Math.cos(a) * R)}L${r1(Math.sin(a) * (R + 8))} ${r1(-Math.cos(a) * (R + 8))}`;
          }).join('')}
        />
        {!detail && (
          <g className="polar-cardinal">
            <text y={-R - 16}>Route to {targetLabel}</text>
          </g>
        )}
        <g clipPath={`url(#${detail ? 'polar-detail-clip' : 'polar-full-clip'})`}>
          {detail && (
            <polygon
              className="polar-corridor"
              points={drawn.corridor.map((p) => `${at(p).x},${at(p).y}`).join(' ')}
            />
          )}
          {drawn.returns.map((ray) => {
            const end = at(clip(ray.at));
            return (
              <line
                key={ray.beam}
                className={ray.hit ? 'polar-ray hit' : 'polar-ray'}
                style={{ '--b': ray.beam } as CSSProperties}
                pathLength={1}
                x1={0}
                y1={0}
                x2={end.x}
                y2={end.y}
              />
            );
          })}
          {drawn.returns.map((ray) =>
            Math.hypot(ray.at.x, ray.at.y) <= view.reach ? (
              <circle
                key={ray.beam}
                className={ray.hit ? 'polar-return hit' : 'polar-return'}
                style={{ '--b': ray.beam } as CSSProperties}
                cx={at(ray.at).x}
                cy={at(ray.at).y}
                r={ray.hit ? (detail ? 4 : 2.6) : detail ? 3 : 1.6}
              />
            ) : null,
          )}
        </g>
        <g className="polar-route">
          <path d={`M${body.x} ${body.y}L${routeEnd.x} ${routeEnd.y}`} />
        </g>
        {detail && drawn.nearest && (
          <g className="polar-nearest">
            <path d={`M${body.x} ${body.y}L${at(drawn.nearest.at).x} ${at(drawn.nearest.at).y}`} />
            <circle cx={body.x} cy={body.y} r={4} />
            <text x={at(drawn.nearest.at).x + 12} y={r1((body.y + at(drawn.nearest.at).y) / 2)}>
              {`${drawn.nearest.distance.toFixed(2)} m`}
            </text>
          </g>
        )}
        {!detail && (
          <g className="polar-detail-mark">
            <circle r={DETAIL.reach * view.scale} />
            <text
              x={DETAIL.reach * view.scale * 0.72 + 6}
              y={DETAIL.reach * view.scale * 0.72 + 14}
            >
              A
            </text>
          </g>
        )}
        <path
          className="polar-sensor"
          d={detail ? 'M0 -14L9 9L0 4L-9 9Z' : 'M0 -10L7 7L0 3L-7 7Z'}
          transform={`rotate(${drawn.heading})`}
        />
      </svg>
    );
  };
  return (
    <div className="polar">
      <figure className="plate">
        {plot(FULL, false)}
        <figcaption>
          All {drawn.returns.length} returns out to {FULL.reach} m, turned so the route points up.
          The arrow is the rover’s heading: it had just inspected the bay and faced away from the
          route.
        </figcaption>
      </figure>
      <figure className="plate">
        {plot(DETAIL, true)}
        <figcaption>
          Detail A at {Math.round(DETAIL.scale / FULL.scale)} times the scale: the corridor the
          gateway tested, {nearest.toFixed(2)} m to the nearest return
        </figcaption>
      </figure>
    </div>
  );
}
