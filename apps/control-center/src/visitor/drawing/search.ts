import type { Scene } from './scenes';

export interface Search {
  /** Shortest distance from the route's start to each place the search settled, in metres. */
  readonly reach: ReadonlyMap<string, number>;
  /** Segments the search followed, each entered at the distance of the place it leaves. */
  readonly probes: readonly { readonly lane: number; readonly at: number }[];
  /** Segments it skipped because a measured condition closed them. */
  readonly closed: readonly { readonly lane: number; readonly at: number }[];
  /** Segment indices of the shortest route, start to destination. */
  readonly route: readonly number[];
  readonly total: number;
}

/**
 * Dijkstra over the map's segments as the route planner reads them: one way, from `from` to `to`,
 * closed segments excluded, lengths measured between place poses. It stops once the destination is
 * settled. The planner also weighs body transfers, so tests check this matches each recorded plan.
 */
export function searchRoute(scene: Scene): Search | null {
  if (!scene.route) return null;
  const { from, to } = scene.route;
  const reach = new Map<string, number>([[from, 0]]);
  const via = new Map<string, number>();
  const settled = new Set<string>();
  const probes: { lane: number; at: number }[] = [];
  const closed: { lane: number; at: number }[] = [];
  for (;;) {
    let current: string | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const [id, distance] of reach)
      if (!settled.has(id) && distance < best) {
        best = distance;
        current = id;
      }
    if (current === undefined) break;
    settled.add(current);
    if (current === to) break;
    scene.lanes.forEach((lane, index) => {
      if (lane.ends[0] !== current) return;
      if (lane.blocked) {
        closed.push({ lane: index, at: best });
        return;
      }
      probes.push({ lane: index, at: best });
      const next = best + lane.length;
      if (next < (reach.get(lane.ends[1]) ?? Number.POSITIVE_INFINITY)) {
        reach.set(lane.ends[1], next);
        via.set(lane.ends[1], index);
      }
    });
  }
  const route: number[] = [];
  for (let at = to; at !== from; ) {
    const lane = via.get(at);
    const segment = lane === undefined ? undefined : scene.lanes[lane];
    if (lane === undefined || !segment) return null;
    route.unshift(lane);
    at = segment.ends[0];
  }
  return { reach, probes, closed, route, total: reach.get(to) ?? 0 };
}
