import type { RoutePlan, SemanticMap } from './navigation';

export function RouteGraph({
  map,
  plan,
}: {
  readonly map: SemanticMap;
  readonly plan?: RoutePlan | null;
}) {
  const xs = map.places.map((place) => place.pose.x);
  const ys = map.places.map((place) => place.pose.y);
  const minX = Math.min(...xs),
    maxX = Math.max(...xs);
  const minY = Math.min(...ys),
    maxY = Math.max(...ys);
  const position = (id: string) => {
    const place = map.places.find((entry) => entry.id === id);
    if (!place) return { x: 0, y: 0 };
    return {
      x: maxX === minX ? 380 : 100 + ((place.pose.x - minX) / (maxX - minX)) * 560,
      y: maxY === minY ? 180 : 290 - ((place.pose.y - minY) / (maxY - minY)) * 220,
    };
  };
  const selected = new Set(plan?.legs.map((leg) => leg.segment_id));
  return (
    <figure className="route-graph">
      <svg
        viewBox="0 0 760 360"
        role="img"
        aria-label="Semantic route map showing permitted segments, capability requirements and transfer points"
      >
        <title>Semantic route map</title>
        <desc>
          Places share the {map.frame_id} frame. Each label includes elevation. Dashed segments are
          closed; double circles permit a reviewed body transfer.
        </desc>
        {map.segments.map((segment) => {
          const from = position(segment.from),
            to = position(segment.to);
          return (
            <g key={segment.id}>
              <title>
                {segment.id.replaceAll('_', ' ')}: {segment.required_capabilities.join(', ')}{' '}
                required; {segment.enabled ? 'open' : 'closed'}
              </title>
              <line
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                className={`route-edge ${!segment.enabled ? 'closed' : selected.has(segment.id) ? 'selected' : segment.required_capabilities.includes('stairs') ? 'stairs' : ''}`}
              />
              <circle
                cx={from.x + (to.x - from.x) * 0.65}
                cy={from.y + (to.y - from.y) * 0.65}
                r="3"
                className="route-direction"
              />
            </g>
          );
        })}
        {map.places.map((place) => {
          const p = position(place.id);
          return (
            <g key={place.id} className="route-place">
              <title>
                {place.label}; {place.pose.z.toFixed(2)} metres elevation;{' '}
                {place.transfer_allowed ? 'reviewed transfer permitted' : 'no transfer'}
              </title>
              {place.transfer_allowed && (
                <circle cx={p.x} cy={p.y} r="17" className="route-transfer-ring" />
              )}
              <circle cx={p.x} cy={p.y} r="10" />
              <text x={p.x} y={p.y - 28} textAnchor="middle">
                {place.label}
              </text>
              <text x={p.x} y={p.y + 36} textAnchor="middle" className="route-elevation">
                z {place.pose.z.toFixed(2)} m
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption>
        Semantic places and permitted route segments · elevations in metres · transfer points use
        double circles. This diagram is a planning map, not a live trajectory.
      </figcaption>
    </figure>
  );
}
