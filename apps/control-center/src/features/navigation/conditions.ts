import { z } from 'zod';
import { auditActorSchema } from '../../core/api/schemas';

const conditionPoseSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite().nullable().optional(),
  yaw: z.number().finite(),
});

export const routeConditionSchema = z.object({
  id: z.string(),
  event_id: z.string(),
  revision: z.number().int().nonnegative(),
  map_digest: z.string(),
  segment_id: z.string(),
  status: z.enum(['blocked', 'clear']),
  reason: z.string(),
  observed_at: z.string(),
  received_at: z.string(),
  actor: auditActorSchema,
  expected_revision: z.number().int().nonnegative().nullable().optional(),
  body_id: z.string().nullable().optional(),
  command_id: z.string().nullable().optional(),
  evidence: z
    .object({
      sensor: z.literal('laser_scan'),
      frame_id: z.literal('map'),
      distance_m: z.number().finite().nonnegative(),
      blocked_samples: z.number().int().nonnegative(),
      scan_sha256: z.string().length(64),
      observer_pose: conditionPoseSchema,
    })
    .nullable()
    .optional(),
});

export const routeConditionsSchema = z.object({
  map_id: z.string(),
  map_digest: z.string(),
  revision: z.number().int().nonnegative(),
  conditions: z.array(routeConditionSchema),
  blocked_segment_ids: z.array(z.string()),
});

export type RouteCondition = z.infer<typeof routeConditionSchema>;
export type RouteConditions = z.infer<typeof routeConditionsSchema>;
export interface ReportRouteCondition {
  event_id: string;
  map_digest: string;
  segment_id: string;
  status: 'blocked' | 'clear';
  reason: string;
  observed_at: string;
  expected_revision?: number;
}
