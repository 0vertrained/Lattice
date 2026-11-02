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
      <div className="route-candidate-grid">
        {assessments.map((assessment) => (
          <article key={assessment.body_id}>
            <strong>{bodyName(assessment.body_id)}</strong>
            <p>
              {assessment.eligible
                ? 'Ready and available at a known place; capability limits below still apply.'
                : 'Excluded from this planning snapshot.'}
            </p>
            <small>
              {assessment.place_id
                ? `Reported place: ${placeName(assessment.place_id)}`
                : 'Placement is unknown.'}
            </small>
            {assessment.reasons.length > 0 && (
              <ul>
                {assessment.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            {assessment.capability_gaps.length > 0 && (
              <ul>
                {assessment.capability_gaps.map((gap) => {
                  const segment = map.segments.find((entry) => entry.id === gap.segment_id);
                  return (
                    <li key={gap.segment_id}>
                      Missing {gap.missing_capabilities.join(', ')} for{' '}
                      {segment
                        ? `${placeName(segment.from)} → ${placeName(segment.to)}`
                        : gap.segment_id.replaceAll('_', ' ')}
                      .
                    </li>
                  );
                })}
              </ul>
            )}
          </article>
        ))}
      </div>
    </details>
  );
}
