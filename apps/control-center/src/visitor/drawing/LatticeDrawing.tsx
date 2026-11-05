import { useEffect, useId, useLayoutEffect, useMemo, useRef } from 'react';
import { signed } from '../format';
import { type Cue, initiallyFilled, intro, opening } from './director';
import { erase, play } from './engine';
import { poseAt } from './geometry';
import { deg, K, layout, PAD, placed, polyline, r1, ring, wedge } from './layout';
import type { Scene } from './scenes';
import './drawing.css';

/** The fading trail behind a body in the replay loop, oldest piece first. */
const TRAIL = [0.08, 0.16, 0.28, 0.42, 0.6, 0.85] as const;
// Styles for the motion layers live here so the opening's stylesheet stays within its budget.
const probeStyle = { stroke: 'var(--ink)', strokeWidth: 2.5 };
const frontStyle = { fill: 'var(--lane)', stroke: 'var(--ink)', strokeWidth: 2 };
const closedStyle = { stroke: 'var(--stop)', strokeWidth: 21, strokeOpacity: 0.4 };
const glowStyle = { stroke: 'var(--lane)', strokeWidth: 6, strokeLinecap: 'round' } as const;
const fanStyle = { fill: 'var(--lane)', fillOpacity: 0.18 };
const beamStyle = { stroke: 'var(--lane)', strokeWidth: 2.5 };
const headStyle = { stroke: 'var(--ink)', strokeWidth: 1.6 };
const nibStyle = { fill: 'var(--lane)' };
const measureStyles = {
  cross: { stroke: 'var(--graphite)', strokeDasharray: '3 4' },
  contour: { stroke: 'var(--lane)', strokeWidth: 3.5 },
  dimension: { stroke: 'var(--ink)', strokeWidth: 1.2, strokeDasharray: '6 3' },
  dot: { fill: 'var(--ink)' },
  box: { fill: 'var(--film)', stroke: 'var(--ink)' },
} as const;
const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function LatticeDrawing({
  scene,
  label,
  mode,
  time = 0,
  run = 0,
  paused = false,
  live = false,
  erasing = false,
  continued = false,
  onCue,
  onErased,
}: {
  readonly scene: Scene;
  readonly label: string;
  /** 'plot' draws the scene when it appears; 'replay' shows the recording at `time`. */
  readonly mode: 'plot' | 'replay';
  readonly time?: number;
  /** Changing this plots the drawing again. */
  readonly run?: number;
  readonly paused?: boolean;
  /** Keep replaying the recorded run once the drawing is complete. */
  readonly live?: boolean;
  /** Retract the drawing, then call `onErased`. */
  readonly erasing?: boolean;
  /** The walls are already on screen from the drawing this one replaces. */
  readonly continued?: boolean;
  readonly onCue?: (cue: Cue) => void;
  readonly onErased?: () => void;
}) {
  const id = useId().replaceAll(':', '');
  const svg = useRef<SVGSVGElement>(null);
  const view = useMemo(() => layout(scene), [scene]);
  const replay = mode === 'replay';
  const pausedRef = useRef(paused);
  const cueRef = useRef(onCue);
  const erasedRef = useRef(onErased);
  useEffect(() => {
    pausedRef.current = paused;
    cueRef.current = onCue;
    erasedRef.current = onErased;
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: changing `run` plots the drawing again.
  useLayoutEffect(() => {
    const root = svg.current;
    if (!root) return;
    if (reduced()) {
      if (erasing) queueMicrotask(() => erasedRef.current?.());
      return;
    }
    if (erasing) return erase(root, () => erasedRef.current?.());
    return play(root, view, replay ? intro(view) : opening(view, continued), {
      id,
      paused: pausedRef,
      onCue: (cue) => cueRef.current?.(cue),
      live: live && !replay,
    });
  }, [view, replay, run, erasing, continued, live, id]);

  // The measuring crosshair: map coordinates under the pointer, the nearest place, and the
  // iso-distance contour through the pointer (a circle about that place, inside its Voronoi cell).
  useEffect(() => {
    const root = svg.current;
    const overlay = root?.querySelector<SVGGElement>('[data-measure]');
    if (!root || !overlay) return;
    const part = (name: string) => overlay.querySelector<SVGElement>(`[data-part="${name}"]`);
    const [cross, contour, dimension, dot, tag, box, first, second] = [
      'cross',
      'contour',
      'dimension',
      'dot',
      'tag',
      'box',
      'first',
      'second',
    ].map(part);
    let frame = 0,
      timer = 0;
    const hide = () => {
      overlay.style.opacity = '0';
    };
    const show = (x: number, y: number) => {
      const matrix = root.getScreenCTM();
      if (!matrix) return;
      const at = new DOMPoint(x, y).matrixTransform(matrix.inverse());
      const { inner } = view;
      if (at.x < inner.x0 || at.x > inner.x1 || at.y < inner.y0 || at.y > inner.y1) return hide();
      const map = view.toMap(at);
      let nearest = -1,
        distance = Number.POSITIVE_INFINITY;
      scene.places.forEach((place, i) => {
        const d = Math.hypot(place.at.x - map.x, place.at.y - map.y);
        if (d < distance) {
          distance = d;
          nearest = i;
        }
      });
      const place = view.places[nearest];
      cross?.setAttribute(
        'd',
        `M${inner.x0} ${r1(at.y)}H${inner.x1}M${r1(at.x)} ${inner.y0}V${inner.y1}`,
      );
      dot?.setAttribute('transform', `translate(${r1(at.x)} ${r1(at.y)})`);
      if (place) {
        contour?.setAttribute('cx', String(place.svg.x));
        contour?.setAttribute('cy', String(place.svg.y));
        contour?.setAttribute('r', String(r1(distance * K)));
        contour?.setAttribute('clip-path', `url(#${id}-cell-${nearest})`);
        dimension?.setAttribute('d', `M${r1(at.x)} ${r1(at.y)}L${place.svg.x} ${place.svg.y}`);
      }
      if (first) first.textContent = `x ${signed(map.x, 2)} m, y ${signed(map.y, 2)} m`;
      if (second) second.textContent = place ? `${distance.toFixed(2)} m to ${place.label}` : '';
      // Lay the tag out for the text size in use (larger on phones).
      const size = Number.parseFloat(getComputedStyle(first ?? overlay).fontSize) || 13;
      first?.setAttribute('x', String(r1(size * 0.8)));
      second?.setAttribute('x', String(r1(size * 0.8)));
      first?.setAttribute('y', String(r1(size * 1.4)));
      second?.setAttribute('y', String(r1(size * 2.75)));
      box?.setAttribute('height', String(r1(size * 3.4)));
      const width =
        Math.max(
          (first as SVGTextContentElement | null)?.getComputedTextLength() ?? 0,
          (second as SVGTextContentElement | null)?.getComputedTextLength() ?? 0,
        ) +
        size * 1.6;
      box?.setAttribute('width', String(r1(width)));
      const height = Number(box?.getAttribute('height') ?? 40);
      const tx = at.x + 16 + width > inner.x1 ? at.x - 16 - width : at.x + 16,
        ty = at.y - 16 - height < inner.y0 ? at.y + 16 : at.y - 16 - height;
      tag?.setAttribute('transform', `translate(${r1(tx)} ${r1(ty)})`);
      overlay.style.opacity = '1';
    };
    const move = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => show(event.clientX, event.clientY));
    };
    const tap = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      show(event.clientX, event.clientY);
      clearTimeout(timer);
      timer = window.setTimeout(hide, 2600);
    };
    root.addEventListener('pointermove', move);
    root.addEventListener('pointerleave', hide);
    root.addEventListener('pointerdown', tap);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      root.removeEventListener('pointermove', move);
      root.removeEventListener('pointerleave', hide);
      root.removeEventListener('pointerdown', tap);
    };
  }, [view, scene.places, id]);

  const filled = useMemo(() => initiallyFilled(view), [view]);
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
          <clipPath id={`${id}-room`}>
            <rect
              x={view.inner.x0}
              y={view.inner.y0}
              width={view.inner.x1 - view.inner.x0}
              height={view.inner.y1 - view.inner.y0}
            />
          </clipPath>
          {view.scan && (
            <>
              <clipPath id={`${id}-sweep`}>
                <path d={wedge(view.scan.origin, 0, 2 * Math.PI)} />
              </clipPath>
              <clipPath id={`${id}-glow`}>
                <path />
              </clipPath>
            </>
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
        {view.stairs?.risers.map((d, i) => (
          <path
            key={d}
            data-k={`riser-${i}`}
            data-pen=""
            pathLength={1}
            className="d-riser"
            d={d}
          />
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
                data-k={filled.has(i) ? `lane-${i}` : `fill-${i}`}
                data-pen=""
                pathLength={1}
                className="d-lane-fill"
                d={lane.d}
              />
            )}
            {lane.blocked && (
              <>
                <path
                  data-k="blocked"
                  data-pen=""
                  pathLength={1}
                  className="d-lane-block"
                  stroke={`url(#${id}-stop)`}
                  d={lane.d}
                />
                <path data-k={`closed-${i}`} className="d-closed" style={closedStyle} d={lane.d} />
              </>
            )}
            {!replay && (
              <path
                data-k={`probe-${i}`}
                data-pen=""
                pathLength={1}
                className="d-probe"
                style={probeStyle}
                d={lane.d}
              />
            )}
            {lane.dim && (
              <text data-k={`dim-${i}`} className="d-dim" transform={lane.dim} textAnchor="middle">
                {`${lane.length.toFixed(2)} m`}
              </text>
            )}
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
            <path
              data-glow=""
              className="d-glow"
              style={glowStyle}
              clipPath={`url(#${id}-glow)`}
              d={view.scan.returns + view.scan.hitReturns}
            />
            <polygon data-k="corridor" className="d-corridor" points={view.scan.corridor}>
              <title>{`Route corridor the gateway tested: ${view.scan.hits} laser returns inside it`}</title>
            </polygon>
            <circle
              data-k="stop-pulse"
              className="d-pulse d-stop-pulse"
              cx={r1(view.scan.barrier.x)}
              cy={r1(view.scan.barrier.y)}
              r="40"
            />
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
            <circle
              data-k={`pulse-${i}`}
              className="d-pulse"
              cx={r1(place.svg.x)}
              cy={r1(place.svg.y)}
              r={r1(place.r + 10)}
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
        {view.search?.costs.map((cost) => (
          <text
            key={cost.place}
            data-k={`cost-${view.places.findIndex((place) => place.id === cost.place)}`}
            className="d-cost"
            x={r1(cost.x)}
            y={r1(cost.y)}
            textAnchor={cost.anchor}
          >
            {`${cost.distance.toFixed(2)} m by route`}
          </text>
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
    [view, scene.solids, id, replay, filled],
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
              {TRAIL.map((opacity, piece) => (
                <path
                  key={opacity}
                  data-trail={`${i}-${piece}`}
                  className="d-trail"
                  style={{ strokeOpacity: opacity, strokeWidth: 2 + piece * 0.6 }}
                />
              ))}
            </g>
          );
        const played = polyline(track.poses.filter((pose) => pose.t <= time).map(view.to));
        return (
          <g key={track.id} data-k="ahead" className={`d-${track.tone}`}>
            <path className="d-track-ahead" d={track.d} />
            {played && <path className="d-casing" d={played} />}
            {played && <path className="d-track" d={played} />}
          </g>
        );
      })}
      {view.marks.map((mark, m) =>
        !replay || mark.t <= time ? (
          <g key={`${mark.kind}-${mark.t}`} transform={mark.transform}>
            <g data-k={`mark-${m}`} className={`d-mark d-${mark.kind}`}>
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
            <circle data-pulse-mark="" className={`d-pulse d-pulse-${mark.kind}`} r="20" />
          </g>
        ) : null,
      )}
      {view.lanes.map((lane, i) =>
        replay ? null : (
          <circle
            key={lane.id}
            data-front={i}
            className="d-front"
            style={frontStyle}
            r="6"
            cx={lane.a.x}
            cy={lane.a.y}
          />
        ),
      )}
      {view.tracks.map((track) => {
        const pose = replay ? poseAt(track.samples, time) : null;
        const transform = replay
          ? pose
            ? placed(view.to(pose), -deg(pose.yaw))
            : null
          : placed(track.points.at(-1) ?? view.origin, -deg(track.poses.at(-1)?.yaw ?? 0));
        return transform ? (
          <g
            key={`glyph-${track.id}`}
            data-glyph=""
            data-k="body"
            className={`d-glyph d-${track.tone}`}
            transform={transform}
          >
            <path d="M12 0L-8 -8L-4 0L-8 8Z" />
          </g>
        ) : null;
      })}
      {view.scan && !replay && (
        // The room clip sits outside the rotating beam, so it stays aligned with the walls.
        <g clipPath={`url(#${id}-room)`}>
          <g data-beam="" className="d-beam">
            <path style={fanStyle} d={wedge(view.scan.origin, -0.5, 0.5, view.scan.reach + 30)} />
            <path
              style={beamStyle}
              d={`M${view.scan.origin.x} ${view.scan.origin.y}h${r1(view.scan.reach + 30)}`}
            />
          </g>
        </g>
      )}
      {!replay && (
        <text data-clock="" className="d-clock" x={view.inner.x0 + 8} y={view.inner.y0 + 18}>
          <tspan data-clock-speed="" />
          <tspan data-clock-time="" dx="10" />
        </text>
      )}
      <g data-head="" className="d-head" style={headStyle}>
        <circle r="7" />
        <path d="M-14 0H-9M9 0H14M0 -14V-9M0 9V14" />
        <circle style={nibStyle} r="2.4" />
      </g>
      <g data-measure="" className="d-measure">
        <path data-part="cross" style={measureStyles.cross} />
        <circle data-part="contour" style={measureStyles.contour} />
        <path data-part="dimension" style={measureStyles.dimension} />
        <g data-part="dot">
          <circle style={measureStyles.dot} r="3.5" />
        </g>
        <g data-part="tag">
          <rect data-part="box" style={measureStyles.box} height="44" />
          <text className="d-measure-text">
            <tspan data-part="first" x="10" y="18" />
            <tspan data-part="second" x="10" y="35" />
          </text>
        </g>
      </g>
    </svg>
  );
}
