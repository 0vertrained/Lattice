import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '../../core/api/apiClient';
import { evidenceSchema } from '../../core/api/schemas';
import { locationLabel, type Observation, observationTime } from './observation';

export function ObservationCard({
  observation,
  bodyName,
}: {
  readonly observation: Observation;
  readonly bodyName: string;
}) {
  const [showImage, setShowImage] = useState(false);
  const evidence = useQuery({
    queryKey: ['observation-evidence', observation.id],
    queryFn: async () =>
      evidenceSchema.parse(
        await apiClient.request(`/observations/${encodeURIComponent(observation.id)}/evidence`),
      ),
    enabled: showImage,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const detected = observation.outcome === 'detected';
  return (
    <article className="observation-card" id={`observation-${observation.id}`}>
      <div className="card-title-row">
        <strong>{locationLabel(observation.location)}</strong>
        <span className={`status-pill ${detected ? 'succeeded' : 'interrupted'}`}>
          {detected ? 'Marker detected' : 'No marker detected'}
        </span>
      </div>
      <dl>
        <div>
          <dt>Observed by</dt>
          <dd>{bodyName}</dd>
        </div>
        <div>
          <dt>Image captured</dt>
          <dd>
            <time dateTime={observation.captured_at}>
              {observationTime(observation.captured_at)}
            </time>
          </dd>
        </div>
        <div>
          <dt>Model</dt>
          <dd>{observation.model_id}</dd>
        </div>
        <div>
          <dt>Detection confidence</dt>
          <dd>
            {observation.confidence === null
              ? 'No detection score'
              : `${(observation.confidence * 100).toFixed(1)}%`}
          </dd>
        </div>
        <div className="full-width">
          <dt>Confidence applies to</dt>
          <dd>{observation.confidence_domain}</dd>
        </div>
        <div className="full-width">
          <dt>Observer position in {observation.map_frame}</dt>
          <dd>
            {observation.observer_pose
              ? `x ${observation.observer_pose.x.toFixed(2)} m · y ${observation.observer_pose.y.toFixed(2)} m · yaw ${observation.observer_pose.yaw.toFixed(2)} rad`
              : 'No observer pose recorded'}
          </dd>
        </div>
      </dl>
      {!detected && (
        <p className="memory-negative">
          This image contains no supported marker detection. It does not establish that a marker is
          absent from the entire station.
        </p>
      )}
      <button
        className="secondary"
        type="button"
        aria-expanded={showImage}
        aria-controls={`observation-image-${observation.id}`}
        onClick={() => setShowImage((shown) => !shown)}
      >
        {showImage ? 'Hide original image' : 'View original image'}
      </button>
      <div id={`observation-image-${observation.id}`} hidden={!showImage}>
        {showImage && evidence.isPending && <p role="status">Loading recorded camera image…</p>}
        {showImage && evidence.error && (
          <p className="notice error" role="alert">
            Original image unavailable: {evidence.error.message}
          </p>
        )}
        {showImage && evidence.data && (
          <figure className="inspection-evidence">
            <img
              src={`data:image/jpeg;base64,${evidence.data.image_base64}`}
              width={320}
              height={240}
              alt={`${bodyName} camera at ${locationLabel(observation.location)}; ${detected ? 'safety marker detected' : 'no supported marker detected'}`}
            />
            <figcaption>
              Original inspection evidence ·{' '}
              <time dateTime={observation.captured_at}>
                {observationTime(observation.captured_at)}
              </time>
            </figcaption>
          </figure>
        )}
      </div>
      <details className="observation-provenance">
        <summary>Observation provenance</summary>
        <dl>
          <div>
            <dt>Station-scoped subject</dt>
            <dd>
              <code>{observation.subject_key}</code>
            </dd>
          </div>
          <div>
            <dt>Observation / mission / command</dt>
            <dd>
              <code>{observation.id}</code>
              <br />
              <code>{observation.mission_id}</code>
              <br />
              <code>{observation.command_id}</code>
            </dd>
          </div>
          <div>
            <dt>Source body</dt>
            <dd>
              <code>{observation.body_id}</code>
            </dd>
          </div>
          <div>
            <dt>Received by core</dt>
            <dd>
              <time dateTime={observation.received_at}>
                {observationTime(observation.received_at)}
              </time>
            </dd>
          </div>
          <div>
            <dt>Observer pose sampled</dt>
            <dd>
              {observation.observer_pose_at
                ? observationTime(observation.observer_pose_at)
                : 'Unavailable'}
            </dd>
          </div>
          <div>
            <dt>Original JPEG SHA-256</dt>
            <dd>
              <code>{observation.image_sha256}</code>
            </dd>
          </div>
          <div>
            <dt>Source frame SHA-256</dt>
            <dd>
              <code>{observation.frame_sha256}</code>
            </dd>
          </div>
        </dl>
      </details>
    </article>
  );
}
