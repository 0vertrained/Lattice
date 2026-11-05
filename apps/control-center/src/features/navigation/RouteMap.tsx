import { type ReactNode, useEffect, useId, useLayoutEffect, useMemo, useState } from 'react';
import type { RoutePlan, SemanticMap } from './navigation';
import { type MapPlace, mapView, revealSearch } from './routeDrawing';

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const ring = (x: number, y: number, r: number) =>
  `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const cross = (x: number, y: number, r: number) =>
  `${ring(x, y, r)}M${x - r - 7} ${y}h${2 * r + 14}M${x} ${y - r - 7}v${2 * r + 14}`;
const metres = (value: number) => `${value.toFixed(2)} m`;
const textX = (place: MapPlace) =>
  place.anchor === 'start'
    ? place.at.x - 10
    : place.anchor === 'end'
      ? place.at.x + 10
      : place.at.x;
/** How far the planner's notes sit from a place, clear of its rings. */
const clear = (place: MapPlace) => (place.transfer ? 36 : 20);
const timing = (delay: number, duration?: number) => ({
  animationDelay: `${delay}ms`,
  ...(duration === undefined ? {} : { animationDuration: `${duration}ms` }),
});

/**
 * The configured map drawn to scale. With a plan, the planner's recorded search plots itself
 * segment by segment, then the selected route is traced back from the destination. The drawing
 * plays once per plan or replay, and appears finished with reduced motion.
 */
export function RouteMap({
  map,
  plan,
  playKey,
  blockedSegmentIds,
  placeName,
  bodyName,
}: {
  readonly map: SemanticMap;
  readonly plan: RoutePlan | null;
  /** Identifies the reviewed plan; a new one plays its search. */
  readonly playKey: string | null;
  readonly blockedSegmentIds: readonly string[];
  readonly placeName: (id: string) => string;
  readonly bodyName: (id: string) => string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const view = useMemo(() => mapView(map), [map]);
  const reveal = useMemo(() => (plan ? revealSearch(plan) : null), [plan]);
  const total = reveal?.total ?? 0;
  // Each play remounts the animated marks under a new number; a settled play stops animating,
  // so showing the section again does not replay it.
  const [run, setRun] = useState(0);
  const [settled, setSettled] = useState(0);
  // A new plan starts before the first paint, so the finished drawing never flashes first.
  useLayoutEffect(() => {
    if (playKey !== null) setRun((current) => current + 1);
  }, [playKey]);
  useEffect(() => {
    if (settled === run) return;
    const timer = window.setTimeout(() => setSettled(run), total + 120);
    return () => window.clearTimeout(timer);
  }, [run, settled, total]);
  const playing = run !== settled && total > 0 && !reducedMotion();

  const blocked = new Set(blockedSegmentIds);
  const selected = new Set(plan?.legs.map((leg) => leg.segment_id));
  const lanes = new Map(view.lanes.map((lane) => [lane.id, lane]));
  const places = new Map(view.places.map((place) => [place.id, place]));
  const traced = new Map(reveal?.trace.map((entry) => [entry.segmentId, entry]));
  const route = plan ? [plan.source_place_id, ...plan.legs.map((leg) => leg.to)] : [];
  const closed = view.lanes.filter((lane) => !lane.enabled);
  const description = [
    `${view.places.length} places joined by ${view.lanes.length} one-way segments.`,
    route.length > 1 ? `The selected route runs ${route.map(placeName).join(', ')}.` : '',
    blocked.size > 0
      ? `Reported blocked: ${[...blocked].map((segment) => segment.replaceAll('_', ' ')).join(', ')}.`
      : '',
    closed.length > 0
      ? `Closed in the map: ${closed.map((lane) => lane.id.replaceAll('_', ' ')).join(', ')}.`
      : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <figure className="route-map-figure">
      <div className="route-map-frame">
        <svg
          className="route-map"
          viewBox={`0 0 ${view.width} ${view.height}`}
          role="img"
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-desc`}
          data-playing={playing ? '' : undefined}
        >
          <title id={`${id}-title`}>Route map, {map.id.replaceAll('_', ' ')}</title>
          <desc id={`${id}-desc`}>{description}</desc>
          <defs>
            <pattern
              id={`${id}-blocked`}
              width="7"
              height="7"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect className="rm-hatch-ground" width="7" height="7" />
              <path className="rm-hatch" d="M0 0V7" />
            </pattern>
          </defs>
          <rect className="rm-film" width={view.width} height={view.height} />
          <path className="rm-minor" d={view.minor} />
          <path className="rm-major" d={view.major} />
          <g className="rm-scale" transform={`translate(${view.scaleBar.x} ${view.scaleBar.y})`}>
            <path d={`M0 -5V0H${view.scale}V-5M${view.scale / 2} -3V0`} />
            <text x={view.scale + 8} y="1">
              1 m
            </text>
          </g>
          {view.lanes.map((lane) => (
            <g key={lane.id} className="rm-lane">
              <title>
                {`${placeName(lane.from)} to ${placeName(lane.to)}, ${metres(lane.lengthM)}, needs ${lane.capabilities.join(' and ')}; ${
                  !lane.enabled
                    ? 'closed in the map'
                    : blocked.has(lane.id)
                      ? 'reported blocked'
                      : selected.has(lane.id)
                        ? 'in the selected route'
                        : 'open'
                }`}
              </title>
              {lane.enabled ? (
                <>
                  <path className="rm-lane-edge" d={lane.d} />
                  <path className="rm-lane-core" d={lane.d} />
                  {blocked.has(lane.id) && (
                    <path className="rm-lane-blocked" stroke={`url(#${id}-blocked)`} d={lane.d} />
                  )}
                </>
              ) : (
                <path className="rm-lane-closed" d={lane.d} />
              )}
            </g>
          ))}
          {reveal?.probes.map((probe) => {
            const lane = lanes.get(probe.segmentId);
            return (
              lane && (
                <path
                  key={`${run}-${probe.segmentId}`}
                  className="rm-probe"
                  pathLength={1}
                  d={lane.d}
                  style={timing(probe.delay, probe.duration)}
                />
              )
            );
          })}
          {plan?.legs.map((leg) => {
            const lane = lanes.get(leg.segment_id);
            const trace = traced.get(leg.segment_id);
            return (
              lane && (
                <path
                  key={`${run}-${leg.segment_id}`}
                  className="rm-selected"
                  pathLength={1}
                  d={lane.d}
                  style={trace ? timing(trace.delay, trace.duration) : undefined}
                />
              )
            );
          })}
          {view.lanes.map(
            (lane) =>
              lane.enabled && (
                <g key={lane.id} className="rm-lane-marks">
                  {lane.risers && <path className="rm-riser" d={lane.risers} />}
                  <path className="rm-chevron" d={lane.chevron} />
                </g>
              ),
          )}
          {view.places.map((place) => (
            <g key={place.id} className="rm-place">
              <title>{placeName(place.id)}</title>
              <path d={cross(place.at.x, place.at.y, 9)} />
              {place.transfer && (
                <path className="rm-transfer" d={ring(place.at.x, place.at.y, 15)} />
              )}
              <text
                className="rm-label"
                x={textX(place)}
                y={place.below ? place.at.y + 34 : place.at.y - (place.raised ? 42 : 24)}
                textAnchor={place.anchor}
              >
                {place.label}
              </text>
              {place.raised && (
                <text
                  className="rm-note"
                  x={textX(place)}
                  y={place.below ? place.at.y + 51 : place.at.y - 24}
                  textAnchor={place.anchor}
                >
                  z {metres(place.z)}
                </text>
              )}
            </g>
          ))}
          {reveal?.costs.map((cost) => {
            const place = places.get(cost.placeId);
            return (
              place && (
                <text
                  key={`${run}-${cost.placeId}`}
                  className="rm-cost"
                  x={textX(place)}
                  y={place.below ? place.at.y - clear(place) : place.at.y + clear(place) + 11}
                  textAnchor={place.anchor}
                  style={timing(cost.delay)}
                >
                  {cost.delay === 0
                    ? 'Start'
                    : cost.transfers > 0
                      ? `${metres(cost.distanceM)}, ${cost.transfers} ${cost.transfers === 1 ? 'change' : 'changes'}`
                      : metres(cost.distanceM)}
                </text>
              )
            );
          })}
          {reveal?.changes.map((change) => {
            const place = places.get(change.placeId);
            return (
              place && (
                <g
                  key={`${run}-${change.placeId}-${change.bodyId}`}
                  className="rm-change"
                  style={timing(change.delay)}
                >
                  <path d={ring(place.at.x, place.at.y, 21)} />
                  <text
                    x={textX(place)}
                    y={
                      place.below ? place.at.y - clear(place) - 17 : place.at.y + clear(place) + 28
                    }
                    textAnchor={place.anchor}
                  >
                    {bodyName(change.bodyId)} takes over
                  </text>
                </g>
              )
            );
          })}
        </svg>
      </div>
      <figcaption>
        <MapLegend
          plan={plan !== null}
          explored={reveal !== null}
          stairs={view.lanes.some((lane) => lane.risers)}
          blocked={view.lanes.some((lane) => lane.enabled && blocked.has(lane.id))}
          closed={closed.length > 0}
          transfer={view.places.some((place) => place.transfer)}
        />
        <p className="route-map-caption">
          A planning map, not a live trajectory. Each segment runs one way, in the direction of its
          chevron. Elevations mark places above the lowest floor.
          {reveal &&
            ' Figures at places are the distance by route when the search first reached them.'}
        </p>
        {reveal && (
          <button
            type="button"
            className="text-button route-replay"
            onClick={() => setRun((current) => current + 1)}
          >
            Replay the search
          </button>
        )}
      </figcaption>
    </figure>
  );
}

function MapLegend({
  plan,
  explored,
  stairs,
  blocked,
  closed,
  transfer,
}: {
  readonly plan: boolean;
  readonly explored: boolean;
  readonly stairs: boolean;
  readonly blocked: boolean;
  readonly closed: boolean;
  readonly transfer: boolean;
}) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const band = (extra?: ReactNode) => (
    <svg viewBox="0 0 40 16" aria-hidden="true">
      <path className="rm-lane-edge" d="M2 8H38" />
      <path className="rm-lane-core" d="M2 8H38" />
      {extra}
    </svg>
  );
  return (
    <ul className="route-legend">
      {plan && <li>{band(<path className="rm-selected" d="M2 8H38" />)}Selected route</li>}
      {explored && (
        <li>
          {band(<path className="rm-probe" d="M2 8H38" />)}
          Settled by the planner’s search
        </li>
      )}
      {stairs && (
        <li>{band(<path className="rm-riser" d="M12 2V14M20 2V14M28 2V14" />)}Needs stairs</li>
      )}
      {blocked && (
        <li>
          {band(
            <>
              <defs>
                <pattern
                  id={`${id}-hatch`}
                  width="7"
                  height="7"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect className="rm-hatch-ground" width="7" height="7" />
                  <path className="rm-hatch" d="M0 0V7" />
                </pattern>
              </defs>
              <path className="rm-lane-blocked" stroke={`url(#${id}-hatch)`} d="M2 8H38" />
            </>,
          )}
          Reported blocked
        </li>
      )}
      {closed && (
        <li>
          <svg viewBox="0 0 40 16" aria-hidden="true">
            <path className="rm-lane-closed" d="M2 8H38" />
          </svg>
          Closed in the map
        </li>
      )}
      {transfer && (
        <li>
          <svg viewBox="0 0 40 16" aria-hidden="true">
            <path className="rm-place-swatch" d={cross(20, 8, 4)} />
            <path className="rm-transfer" d={ring(20, 8, 7)} />
          </svg>
          Body transfer allowed
        </li>
      )}
    </ul>
  );
}

/** The recorded search as text: what the drawing shows, step by step. */
export function SearchSteps({
  plan,
  placeName,
  bodyName,
  segmentName,
}: {
  readonly plan: RoutePlan;
  readonly placeName: (id: string) => string;
  readonly bodyName: (id: string) => string;
  readonly segmentName: (id: string) => string;
}) {
  if (plan.search.length === 0) return null;
  const last = plan.search.length - 1;
  return (
    <details className="route-search-steps">
      <summary>How the planner searched</summary>
      <p className="route-note">
        The planner settles the cheapest state first: fewer body changes, then the shorter summed
        distance between places. It stops at the first state that reaches the destination with a
        body able to do the destination task. Each segment is listed once per body.
      </p>
      <ol>
        {plan.search.map((step, index) => (
          <li
            key={`${step.reached_by}-${step.segment_id ?? step.place_id}-${step.body_id}`}
            data-goal={index === last ? '' : undefined}
          >
            {step.reached_by === 'start'
              ? `Starts at ${placeName(step.place_id)} with ${bodyName(step.body_id)}.`
              : step.reached_by === 'transfer'
                ? `${bodyName(step.body_id)} could take over at ${placeName(step.place_id)}.`
                : `${segmentName(step.segment_id ?? '')} with ${bodyName(step.body_id)}.`}{' '}
            <span className="figures">
              {metres(step.distance_m)}
              {step.transfers > 0 &&
                `, ${step.transfers} body ${step.transfers === 1 ? 'change' : 'changes'}`}
            </span>
            {index === last && ' Reaches the destination.'}
          </li>
        ))}
      </ol>
    </details>
  );
}
