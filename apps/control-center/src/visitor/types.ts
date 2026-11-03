export interface Pose {
  t: number;
  x: number;
  y: number;
  yaw: number;
  mission_id: string;
  status: string;
}
export interface Event {
  t: number;
  title: string;
  detail: string;
  kind: string;
}
export interface Evidence {
  title: string;
  outcome: string;
  image: string;
  image_sha256: string;
  frame_sha256: string;
  model_id: string;
  confidence_domain: string;
  /** When the camera captured the frame, in Unix milliseconds. */
  captured_at_ms?: number;
  /** Box is [x, y, width, height] in the 320 × 240 frame. */
  detections: { label: string; confidence: number; box?: [number, number, number, number] }[];
}
export interface Walkthrough {
  schema: string;
  recorded_at: string;
  duration_s: number;
  distance_m: number;
  round_id: string;
  digest: string;
  outcome: string;
  anomaly_count: number;
  steps: { title: string; command: Record<string, unknown>; continue_on_missing_marker: boolean }[];
  poses: Pose[];
  events: Event[];
  evidence: Evidence[];
  recovery: {
    stop_observed_after_s: number;
    post_stop_drift_m: number;
    automatic_resume: boolean;
    operator_approved_recovery: string;
  };
}
