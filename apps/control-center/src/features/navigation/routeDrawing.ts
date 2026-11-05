import type { RoutePlan, SemanticMap } from './navigation';

/** The drawing is 720 units wide; one metre takes whatever the map's extent leaves room for. */
export const VIEW_WIDTH = 720;
const MAX_HEIGHT = 540;
/** Room around the outermost places for their labels, in metres. */
const MARGIN_X = 1.4;
const MARGIN_Y = 1.1;
/** Two one-way lanes between the same places run side by side, this far apart. */
const LANE_GAP_M = 0.16;
const MINOR_M = 0.25;

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface MapPlace {
  readonly id: string;
  /** The place's name before any " · " detail, so the drawing stays legible. */
  readonly label: string;
  readonly at: Point;
  readonly z: number;
  readonly transfer: boolean;
  /** Above the lowest floor, so its elevation is worth labelling. */
  readonly raised: boolean;
  /** The name sits on the side away from the place's lanes; the planner's cost on the other. */
  readonly below: boolean;
  readonly anchor: 'start' | 'middle' | 'end';
}

export interface MapLane {
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly d: string;
  /** A chevron at the middle, pointing the one way the lane may be driven. */
  readonly chevron: string;
  /** Risers across the lane when it needs a body that can climb stairs. */
  readonly risers: string | null;
  readonly enabled: boolean;
  readonly lengthM: number;
  readonly capabilities: readonly string[];
}

export interface MapView {
  readonly width: number;
  readonly height: number;
  /** Drawing units per metre. */
  readonly scale: number;
  readonly minor: string;
  readonly major: string;
  /** Left end of the one-metre scale bar. */
  readonly scaleBar: Point;
  readonly places: readonly MapPlace[];
  readonly lanes: readonly MapLane[];
}

const r1 = (value: number) => Math.round(value * 10) / 10;

/** Lays the map out to scale, north up, with a drafting grid aligned to the map frame. */
export function mapView(map: SemanticMap): MapView {
  const xs = map.places.map((place) => place.pose.x);
  const ys = map.places.map((place) => place.pose.y);
  const minX = Math.min(...xs);
  const maxY = Math.max(...ys);
  const spanX = Math.max(Math.max(...xs) - minX, 1);
  const spanY = Math.max(maxY - Math.min(...ys), 1);
  const scale = Math.min(VIEW_WIDTH / (spanX + 2 * MARGIN_X), MAX_HEIGHT / (spanY + 2 * MARGIN_Y));
  const height = r1((spanY + 2 * MARGIN_Y) * scale);
  // A tall map leaves room on either side; centre it.
  const left = minX - MARGIN_X - (VIEW_WIDTH / scale - (spanX + 2 * MARGIN_X)) / 2;
  const top = maxY + MARGIN_Y;
  const to = (pose: { readonly x: number; readonly y: number }): Point => ({
    x: r1((pose.x - left) * scale),
    y: r1((top - pose.y) * scale),
  });

  let minor = '';
  let major = '';
  const right = left + VIEW_WIDTH / scale;
  const bottom = top - height / scale;
  // Whole steps of the minor spacing, so every fourth line lands exactly on a metre.
  const perMetre = Math.round(1 / MINOR_M);
  for (let i = Math.ceil(left / MINOR_M); i * MINOR_M <= right; i++) {
    const line = `M${to({ x: i * MINOR_M, y: top }).x} 0V${height}`;
    if (i % perMetre === 0) major += line;
    else minor += line;
  }
  for (let i = Math.ceil(bottom / MINOR_M); i * MINOR_M <= top; i++) {
    const line = `M0 ${to({ x: left, y: i * MINOR_M }).y}H${VIEW_WIDTH}`;
    if (i % perMetre === 0) major += line;
    else minor += line;
  }

  const byId = new Map(map.places.map((place) => [place.id, place]));
  const floor = Math.min(...map.places.map((place) => place.pose.z));
  const places = map.places.map((place): MapPlace => {
    const at = to(place.pose);
    const neighbours = map.segments.flatMap((segment) =>
      segment.from === place.id ? [segment.to] : segment.to === place.id ? [segment.from] : [],
    );
    const rise =
      neighbours.reduce(
        (sum, id) => sum + ((byId.get(id)?.pose.y ?? place.pose.y) - place.pose.y),
        0,
      ) / Math.max(neighbours.length, 1);
    return {
      id: place.id,
      label: place.label.split(' · ')[0] ?? place.label,
      at,
      z: place.pose.z,
      transfer: place.transfer_allowed,
      raised: place.pose.z > floor + 0.005,
      below: rise > 0.25,
      anchor: at.x < VIEW_WIDTH * 0.18 ? 'start' : at.x > VIEW_WIDTH * 0.82 ? 'end' : 'middle',
    };
  });

  const lanes = map.segments.flatMap((segment): MapLane[] => {
    const from = byId.get(segment.from);
    const end = byId.get(segment.to);
    if (!from || !end) return [];
    let a = to(from.pose);
    let b = to(end.pose);
    const length = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const dir = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
    // The right-hand side of travel, with the drawing's y pointing down.
    const side = { x: -dir.y, y: dir.x };
    if (map.segments.some((other) => other.from === segment.to && other.to === segment.from)) {
      const shift = (LANE_GAP_M / 2) * scale;
      a = { x: r1(a.x + side.x * shift), y: r1(a.y + side.y * shift) };
      b = { x: r1(b.x + side.x * shift), y: r1(b.y + side.y * shift) };
    }
    const at = (t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    const mid = at(0.5);
    const tip = { x: mid.x + dir.x * 5, y: mid.y + dir.y * 5 };
    const back = { x: mid.x - dir.x * 5, y: mid.y - dir.y * 5 };
    const chevron = `M${r1(back.x + side.x * 5)} ${r1(back.y + side.y * 5)}L${r1(tip.x)} ${r1(tip.y)}L${r1(back.x - side.x * 5)} ${r1(back.y - side.y * 5)}`;
    let risers: string | null = null;
    if (segment.required_capabilities.includes('stairs')) {
      risers = '';
      const step = (0.18 * scale) / length;
      for (let t = 0.22; t <= 0.78 + 1e-9; t += step) {
        const p = at(t);
        risers += `M${r1(p.x + side.x * 9)} ${r1(p.y + side.y * 9)}L${r1(p.x - side.x * 9)} ${r1(p.y - side.y * 9)}`;
      }
    }
    return [
      {
        id: segment.id,
        from: segment.from,
        to: segment.to,
        d: `M${a.x} ${a.y}L${b.x} ${b.y}`,
        chevron,
        risers,
        enabled: segment.enabled,
        lengthM: Math.hypot(
          end.pose.x - from.pose.x,
          end.pose.y - from.pose.y,
          end.pose.z - from.pose.z,
        ),
        capabilities: segment.required_capabilities,
      },
    ];
  });

  return {
    width: VIEW_WIDTH,
    height,
    scale: r1(scale),
    minor,
    major,
    scaleBar: { x: 24, y: r1(height - 22) },
    places,
    lanes,
  };
}

/** Timing for drawing the search, in milliseconds. */
export const SEARCH_BUDGET_MS = 1800;
export const STEP_MIN_MS = 240;
export const STEP_MAX_MS = 420;
export const TRACE_MS = 420;
const TRACE_PAUSE_MS = 250;

export interface SearchReveal {
  /** Each segment the search first settled, drawn in that order. */
  readonly probes: readonly {
    readonly segmentId: string;
    readonly delay: number;
    readonly duration: number;
  }[];
  /** The planner's cost at each place, shown when the search first settles it. */
  readonly costs: readonly {
    readonly placeId: string;
    readonly distanceM: number;
    readonly transfers: number;
    readonly delay: number;
  }[];
  /** Changes of body the search considered. */
  readonly changes: readonly {
    readonly placeId: string;
    readonly bodyId: string;
    readonly delay: number;
  }[];
  /** The selected route, traced back from the destination once the search is drawn. */
  readonly trace: readonly {
    readonly segmentId: string;
    readonly delay: number;
    readonly duration: number;
  }[];
  readonly total: number;
}

/** Schedules the planner's recorded search at a steady pen speed; null when none was recorded. */
export function revealSearch(plan: RoutePlan): SearchReveal | null {
  if (plan.search.length === 0) return null;
  const moves = plan.search.length - 1;
  const step = Math.min(STEP_MAX_MS, Math.max(STEP_MIN_MS, SEARCH_BUDGET_MS / Math.max(moves, 1)));
  const probes: { segmentId: string; delay: number; duration: number }[] = [];
  const costs: { placeId: string; distanceM: number; transfers: number; delay: number }[] = [];
  const changes: { placeId: string; bodyId: string; delay: number }[] = [];
  const drawn = new Set<string>();
  const costed = new Set<string>();
  plan.search.forEach((entry, index) => {
    const start = Math.max(index - 1, 0) * step;
    const arrive = index === 0 ? 0 : start + step;
    if (entry.reached_by === 'leg' && entry.segment_id && !drawn.has(entry.segment_id)) {
      drawn.add(entry.segment_id);
      probes.push({ segmentId: entry.segment_id, delay: start, duration: Math.round(step * 0.9) });
    }
    if (entry.reached_by === 'transfer')
      changes.push({ placeId: entry.place_id, bodyId: entry.body_id, delay: arrive });
    if (entry.reached_by !== 'transfer' && !costed.has(entry.place_id)) {
      costed.add(entry.place_id);
      costs.push({
        placeId: entry.place_id,
        distanceM: entry.distance_m,
        transfers: entry.transfers,
        delay: arrive,
      });
    }
  });
  const traceStart = moves * step + TRACE_PAUSE_MS;
  const trace = [...plan.legs].reverse().map((leg, index) => ({
    segmentId: leg.segment_id,
    delay: traceStart + index * TRACE_MS,
    duration: TRACE_MS,
  }));
  return { probes, costs, changes, trace, total: traceStart + plan.legs.length * TRACE_MS };
}

export interface RankedRoute {
  readonly selected: boolean;
  /** Places in travel order. */
  readonly placeIds: readonly string[];
  readonly transferPlaceIds: readonly string[];
  /** Bodies in the order they hold the objective. */
  readonly bodyIds: readonly string[];
  readonly distanceM: number;
}

/** The selected route, then the alternatives the planner ranked below it. */
export function rankRoutes(plan: RoutePlan, map: SemanticMap): RankedRoute[] {
  const selected: RankedRoute = {
    selected: true,
    placeIds: [plan.source_place_id, ...plan.legs.map((leg) => leg.to)],
    transferPlaceIds: plan.transfers.map((transfer) => transfer.place_id),
    bodyIds: [plan.source_body_id, ...plan.transfers.map((transfer) => transfer.target_body_id)],
    distanceM: plan.distance_m,
  };
  const segment = (id: string) => map.segments.find((entry) => entry.id === id);
  return [
    selected,
    ...plan.alternatives.map((alternative): RankedRoute => {
      const first = alternative.segment_ids[0];
      const bodies = [...alternative.body_ids, alternative.destination_body_id].filter(
        (body, index, all) => index === 0 || all[index - 1] !== body,
      );
      return {
        selected: false,
        placeIds: [
          first ? (segment(first)?.from ?? plan.source_place_id) : plan.source_place_id,
          ...alternative.segment_ids.map((id) => segment(id)?.to ?? id),
        ],
        transferPlaceIds: alternative.transfer_place_ids,
        bodyIds: bodies,
        distanceM: alternative.distance_m,
      };
    }),
  ];
}
