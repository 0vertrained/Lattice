import { useId } from 'react';
import type { RoutePlan, SemanticMap } from './navigation';
import { rankRoutes } from './routeDrawing';

/** The selected route beside the complete routes the planner ranked below it. */
export function RouteRanking({
  plan,
  map,
  placeName,
  bodyName,
}: {
  readonly plan: RoutePlan;
  readonly map: SemanticMap;
  readonly placeName: (id: string) => string;
  readonly bodyName: (id: string) => string;
}) {
  const heading = useId();
  const routes = rankRoutes(plan, map);
  return (
    <section className="route-ranking" aria-labelledby={heading}>
      <h4 id={heading}>Routes the planner compared</h4>
      <table>
        <thead>
          <tr>
            <th scope="col">Rank</th>
            <th scope="col">Places</th>
            <th scope="col">Bodies</th>
            <th scope="col">Distance</th>
          </tr>
        </thead>
        <tbody>
          {routes.map((route, index) => (
            <tr
              key={`${route.placeIds.join('/')}-${route.bodyIds.join('/')}`}
              data-selected={route.selected ? '' : undefined}
            >
              <td>
                <span className="figures">{index + 1}</span>
                {route.selected && <small>Selected</small>}
              </td>
              <td>
                <ol className="route-path">
                  {route.placeIds.map((place, step) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: A route may pass the same place twice only in order.
                    <li key={`${step}-${place}`}>{placeName(place)}</li>
                  ))}
                </ol>
              </td>
              <td>
                {route.bodyIds.map((body, step) => (
                  <span key={body} className="route-body">
                    {step === 0
                      ? bodyName(body)
                      : `then ${bodyName(body)} at ${placeName(route.transferPlaceIds[step - 1] ?? '')}`}
                  </span>
                ))}
              </td>
              <td className="figures">{route.distanceM.toFixed(2)} m</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="route-note">
        {routes.length === 1
          ? 'The search reached no other route to the destination that avoids revisiting a place.'
          : 'In the planner’s own order: fewer body changes first, then the shorter summed straight-line distance between places. Only the selected route can be approved.'}
      </p>
    </section>
  );
}
