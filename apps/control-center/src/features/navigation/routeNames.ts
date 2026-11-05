import type { Body } from '../../core/api/schemas';
import type { SemanticMap } from './navigation';

/** A speed limit as reviewed, without single-precision noise: 0.30000001192092896 reads "0.3 m/s". */
export function speed(metresPerSecond: number): string {
  return `${Number(metresPerSecond.toFixed(2))} m/s`;
}

/** "warehouse_adaptive" reads "Warehouse adaptive". */
export function sentence(id: string): string {
  const words = id.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface RouteNames {
  readonly placeName: (id: string) => string;
  readonly bodyName: (id: string) => string;
  /** A segment by its two places, "Inspection bay to Stair transfer". */
  readonly segmentName: (id: string) => string;
}

/** Names for places, bodies and segments, shared by the planner and the panels below it. */
export function routeNames(map: SemanticMap | undefined, bodies: readonly Body[]): RouteNames {
  const placeName = (id: string) =>
    map?.places.find((place) => place.id === id)?.label ?? sentence(id);
  return {
    placeName,
    bodyName: (id) => bodies.find((body) => body.id === id)?.display_name ?? id,
    segmentName: (id) => {
      const segment = map?.segments.find((entry) => entry.id === id);
      return segment ? `${placeName(segment.from)} to ${placeName(segment.to)}` : sentence(id);
    },
  };
}
