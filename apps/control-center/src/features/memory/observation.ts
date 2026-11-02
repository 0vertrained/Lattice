import { z } from 'zod';

export const observationSchema = z.object({
  id: z.string(),
  subject_key: z.string(),
  subject_class: z.literal('octagonal_safety_marker'),
  outcome: z.enum(['detected', 'not_detected']),
  location: z.string(),
  map_frame: z.string(),
  observer_pose: z.object({ x: z.number(), y: z.number(), yaw: z.number() }).nullable(),
  observer_pose_at: z.string().nullable(),
  mission_id: z.string(),
  command_id: z.string(),
  body_id: z.string(),
  captured_at: z.string(),
  received_at: z.string(),
  model_id: z.string(),
  confidence_domain: z.string(),
  confidence: z.number().min(0).max(1).nullable(),
  image_sha256: z.string().length(64),
  frame_sha256: z.string().length(64),
  detections: z.array(
    z.object({
      label: z.string(),
      confidence: z.number().min(0).max(1),
      box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    }),
  ),
});

export const lastSeenSchema = z.object({
  subject_key: z.string().nullable(),
  last_seen: observationSchema.nullable(),
  later_negative: observationSchema.nullable(),
  queried_at: z.string(),
  explanation: z.string(),
});

export type Observation = z.infer<typeof observationSchema>;

export function locationLabel(location: string): string {
  return location.replaceAll('_', ' ');
}

export function observationTime(value: string): string {
  return new Date(value).toLocaleString();
}
