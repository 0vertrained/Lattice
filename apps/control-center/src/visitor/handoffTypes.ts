import type { Observation } from '../features/memory/observation';
import type { Event, Walkthrough } from './types';

export interface HandoffRecording {
  schema: 'lattice.handoff.v1';
  recorded_at: string;
  duration_s: number;
  round_id: string;
  digest: string;
  outcome: string;
  anomaly_count: number;
  steps: Walkthrough['steps'];
  poses: { t: number; body_id: string; x: number; y: number; yaw: number; status: string }[];
  events: Event[];
  observations: (Observation & { image: string })[];
  handoff: {
    id: string;
    source_body_id: string;
    target_body_id: string;
    context_digest: string;
    completed_steps: number;
    remaining_steps: number;
    source_stop_observed_after_s: number;
    post_stop_drift_m: number;
    context_acknowledged_at: string;
    not_before_at: string;
    approved_at: string;
  };
  distance_by_body_m: Record<string, number>;
}
