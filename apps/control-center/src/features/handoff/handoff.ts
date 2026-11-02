import { z } from 'zod';
import { skillCommandSchema } from '../../core/api/schemas';

const stepSchema = z.object({
  title: z.string(),
  command: skillCommandSchema,
  continue_on_missing_marker: z.boolean(),
});

export const handoffRoundSchema = z.object({
  id: z.string(),
  status: z.string(),
  steps: z.array(stepSchema),
  current_step: z.number(),
  current_mission_id: z.string().nullable(),
  assigned_body_id: z.string().nullable().optional(),
  route_plan_id: z.string().nullable().optional(),
});

export const handoffSchema = z.object({
  id: z.string(),
  digest: z.string(),
  round_id: z.string(),
  source_body_id: z.string(),
  target_body_id: z.string(),
  created_at: z.string(),
  expires_at: z.string(),
  not_before_at: z.string(),
  status: z.enum(['pending', 'approved', 'invalidated']),
  completed_steps: z.array(stepSchema),
  remaining_steps: z.array(stepSchema),
  retained_observation_ids: z.array(z.string()),
  context: z.object({
    handoff_id: z.string(),
    round_id: z.string(),
    source_body_id: z.string(),
    target_body_id: z.string(),
    completed_steps: z.number(),
    observations: z.array(z.object({ observation_id: z.string(), image_sha256: z.string() })),
    digest: z.string(),
  }),
  source_mission_id: z.string(),
  resumed_mission_id: z.string().nullable(),
  approved_at: z.string().nullable(),
  context_acknowledged_at: z.string().nullable(),
});

export type Handoff = z.infer<typeof handoffSchema>;
export type HandoffStep = z.infer<typeof stepSchema>;

export const transferOptionsSchema = z.object({
  round_id: z.string(),
  route_plan_id: z.string().nullable(),
  current_step: z.number(),
  required: z.boolean(),
  source_body_id: z.string().nullable(),
  recommended_target_body_id: z.string().nullable(),
  transfer_place_id: z.string().nullable(),
  reason: z.string(),
  ready: z.boolean(),
  blocking_reasons: z.array(z.string()),
  map_digest: z.string().nullable(),
});
