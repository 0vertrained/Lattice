import { StatusChip } from '../status';
import type { RouteAssessment, SemanticMap } from './navigation';

export function CandidateAssessments({
  assessments,
  bodyName,
  placeName,
  map,
}: {
  readonly assessments: readonly RouteAssessment[];
  readonly bodyName: (id: string) => string;
  readonly placeName: (id: string) => string;
  readonly map: SemanticMap;
}) {
  if (assessments.length === 0) return null;
  return (
    <details className="route-candidates" open>
      <summary>Candidate readiness and capability limits</summary>
      <ul>
        {assessments.map((assessment) => (
          <li key={assessment.body_id}>
            <div className="card-title-row">
              <div>
                <strong>{bodyName(assessment.body_id)}</strong>
                <small>
                  {assessment.place_id
                    ? `Reported at ${placeName(assessment.place_id)}`
                    : 'Placement is unknown'}
                </small>
              </div>
              <StatusChip
                status={assessment.eligible ? 'ready' : 'excluded'}
                label={assessment.eligible ? 'Ready' : 'Excluded'}
              />
            </div>
            <p>
              {assessment.eligible
                ? 'Ready and available at a known place; the capability limits below still apply.'
                : 'Excluded from this planning snapshot.'}
            </p>
            {(assessment.reasons.length > 0 || assessment.capability_gaps.length > 0) && (
              <ul>
                {assessment.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
                {assessment.capability_gaps.map((gap) => {
                  const segment = map.segments.find((entry) => entry.id === gap.segment_id);
                  return (
                    <li key={gap.segment_id}>
                      Missing {gap.missing_capabilities.join(', ')} for{' '}
                      {segment
                        ? `${placeName(segment.from)} to ${placeName(segment.to)}`
                        : gap.segment_id === 'destination_task'
                          ? 'the destination task'
                          : gap.segment_id.replaceAll('_', ' ')}
                      .
                    </li>
                  );
                })}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
