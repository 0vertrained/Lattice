import { z } from 'zod';
import { handoffRoundSchema } from '../handoff/handoff';
import { routeProposalSchema } from './navigation';

export const replanRoundSchema = handoffRoundSchema.extend({ digest: z.string() });
export const routeReplanSchema = z.object({
  id: z.string(),
  digest: z.string(),
  round_id: z.string(),
  round_digest: z.string(),
  original_route_plan_id: z.string(),
  original_objective: routeProposalSchema.shape.request,
  source_body_id: z.string(),
  source_place_id: z.string().nullable(),
  completed_steps: routeProposalSchema.shape.steps,
  remaining_steps: routeProposalSchema.shape.steps,
  step_body_ids: z.array(z.string()),
  retained_mission_ids: z.array(z.string()),
  retained_observation_ids: z.array(z.string()),
  plan: routeProposalSchema.shape.plan,
  failure: routeProposalSchema.shape.failure,
  conditions_revision: z.number().int().nonnegative(),
  blocked_segment_ids: z.array(z.string()),
  created_at: z.string(),
  expires_at: z.string(),
  not_before_at: z.string(),
  status: z.enum(['pending', 'blocked', 'approved', 'invalidated']),
  approved_at: z.string().nullable().optional(),
});
export type RouteReplan = z.infer<typeof routeReplanSchema>;
export type ReplanRound = z.infer<typeof replanRoundSchema>;
