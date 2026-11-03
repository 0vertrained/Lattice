import type { AdaptiveRecording, AdaptiveScan } from './adaptiveTypes';

export function AdaptiveMap({
  run,
  scan,
  original,
}: {
  readonly run: AdaptiveRecording;
  readonly scan: AdaptiveScan | null;
  readonly original: boolean;
}) {
  const points = scan
    ? scan.ranges.flatMap((range, index) => {
        if (range === null || range < scan.range_min || range > Math.min(2, scan.range_max))
          return [];
        const angle = scan.sensor_map_pose.yaw + scan.angle_min + index * scan.angle_increment;
        return [
          {
            beam: index,
            x: scan.sensor_map_pose.x + range * Math.cos(angle),
            y: scan.sensor_map_pose.y + range * Math.sin(angle),
          },
        ];
      })
    : [];
  const positions = [...run.map.places.map((place) => place.pose), ...points];
  const minX = Math.min(...positions.map((point) => point.x)),
    maxX = Math.max(...positions.map((point) => point.x));
  const minY = Math.min(...positions.map((point) => point.y)),
    maxY = Math.max(...positions.map((point) => point.y));
  const xy = (point: { x: number; y: number }) => ({
    x: 100 + ((point.x - minX) / Math.max(1, maxX - minX)) * 540,
    y: 310 - ((point.y - minY) / Math.max(1, maxY - minY)) * 230,
  });
  const plan = original ? run.initial_plan : run.plan;
  const selected = new Set(plan.legs.map((leg) => leg.segment_id));
  return (
    <figure className="adaptive-map">
      <svg
        className="warehouse-map"
        viewBox="0 0 740 390"
        role="img"
        aria-label={
          original
            ? 'Original route with measured blockage scan returns'
            : 'Reviewed detour with measured blockage scan returns'
        }
      >
        <rect x="25" y="25" width="690" height="340" className="warehouse-floor" />
        {run.map.segments.map((segment) => {
          const from = run.map.places.find((place) => place.id === segment.from),
            to = run.map.places.find((place) => place.id === segment.to);
          if (!from || !to) return null;
          const a = xy(from.pose),
            b = xy(to.pose),
            blocked = segment.id === run.adaptation.blocked_segment_id;
          return (
            <line
              key={segment.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              style={{
                stroke: blocked
                  ? 'var(--stop)'
                  : selected.has(segment.id)
                    ? 'var(--ink)'
                    : 'var(--graphite)',
              }}
              strokeWidth={selected.has(segment.id) ? 4 : 2}
              strokeDasharray={blocked ? '7 6' : undefined}
            >
              <title>
                {segment.id.replaceAll('_', ' ')}:{' '}
                {blocked
                  ? 'reported blocked'
                  : selected.has(segment.id)
                    ? 'in the displayed plan'
                    : 'available map segment'}
              </title>
            </line>
          );
        })}
        <g className="adaptive-scan-returns">
          {points.map((point) => {
            const p = xy(point);
            return (
              <circle key={point.beam} cx={p.x} cy={p.y} r="2" style={{ fill: 'var(--stop)' }} />
            );
          })}
        </g>
        {scan && (
          <g transform={`translate(${xy(scan.sensor_map_pose).x},${xy(scan.sensor_map_pose).y})`}>
            <circle r="6" style={{ fill: 'var(--body)' }} />
            <title>Recorded lidar sensor position</title>
          </g>
        )}
        {run.map.places.map((place, index) => {
          const p = xy(place.pose);
          const anchor = p.x < 200 ? 'start' : p.x > 540 ? 'end' : 'middle';
          return (
            <g key={place.id} transform={`translate(${p.x},${p.y})`}>
              <circle
                r={place.transfer_allowed ? 12 : 8}
                className="map-station adaptive-map-station"
              />
              <text
                className="adaptive-place-number"
                textAnchor="middle"
                dominantBaseline="central"
              >
                {index + 1}
              </text>
              <text
                y={place.transfer_allowed ? 28 : -25}
                textAnchor={anchor}
                className="map-label adaptive-map-label"
              >
                {place.label}
              </text>
              <text
                y={place.transfer_allowed ? 42 : -11}
                textAnchor={anchor}
                className="map-label adaptive-map-label"
              >
                z {place.pose.z.toFixed(2)} m
              </text>
            </g>
          );
        })}
      </svg>
      <ol className="adaptive-place-legend" aria-label="Route place key">
        {run.map.places.map((place) => (
          <li key={place.id}>
            {place.label} <span>· z {place.pose.z.toFixed(2)} m</span>
          </li>
        ))}
      </ol>
      <figcaption>
        Solid line: displayed plan. Dashed red: reported blocked segment. Red dots: actual scan
        returns within 2 m, transformed with the recorded sensor pose; the blue dot is the sensor.
        The points do not classify the object.
      </figcaption>
    </figure>
  );
}
