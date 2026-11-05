import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { apiClient } from '../../core/api/apiClient';
import { evidenceSchema } from '../../core/api/schemas';

export function RetainedEvidence({
  observationId,
  imageHash,
}: {
  readonly observationId: string;
  readonly imageHash: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const evidence = useQuery({
    queryKey: ['observation-evidence', observationId],
    queryFn: async () =>
      evidenceSchema.parse(
        await apiClient.request(`/observations/${encodeURIComponent(observationId)}/evidence`),
      ),
    enabled: open,
    staleTime: Number.POSITIVE_INFINITY,
  });
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Retained image from {observationId}</summary>
      {imageHash && (
        <p className="memory-note">
          Reviewed JPEG SHA-256 <code>{imageHash}</code>
        </p>
      )}
      {open && evidence.isPending && <p role="status">Loading retained evidence…</p>}
      {open && evidence.error && (
        <p className="notice error" role="alert">
          {evidence.error.message}
        </p>
      )}
      {open && evidence.data && (
        <figure className="inspection-evidence">
          <img
            src={`data:image/jpeg;base64,${evidence.data.image_base64}`}
            width={320}
            height={240}
            alt={`Retained camera evidence from observation ${observationId}`}
          />
          <figcaption>
            {evidence.data.detections.length === 0
              ? 'No supported marker detected'
              : `${evidence.data.detections.length} supported marker detection(s)`}
            <small>
              {evidence.data.model_id}, {new Date(evidence.data.captured_at_ms).toLocaleString()}
            </small>
            <small>{evidence.data.confidence_domain}</small>
          </figcaption>
        </figure>
      )}
    </details>
  );
}
