import { z } from 'zod';
import { capabilitySchema, skillCommandSchema } from '../../core/api/schemas';

const poseSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
const placeSchema = z.object({
  id: z.string(),
  label: z.string(),
  pose: poseSchema,
  arrival_radius_m: z.number().positive(),
  transfer_allowed: z.boolean(),
});
export const semanticMapSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  frame_id: z.string(),
  places: z.array(placeSchema).min(1),
  segments: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      required_capabilities: z.array(capabilitySchema),
      max_speed_mps: z.number().positive(),
      enabled: z.boolean(),
    }),
  ),
});
const assessmentSchema = z.object({
  body_id: z.string(),
  place_id: z.string().nullable(),
  eligible: z.boolean(),
  reasons: z.array(z.string()),
  capability_gaps: z.array(
    z.object({ segment_id: z.string(), missing_capabilities: z.array(capabilitySchema) }),
  ),
});
const routeRequestSchema = z.object({
  source_body_id: z.string(),
  source_place_id: z.string(),
  destination_place_id: z.string(),
  destination_capability: capabilitySchema.nullable().optional(),
});
const objectiveSchema = z.object({
  route: routeRequestSchema,
  inspect_source: z.boolean(),
  inspect_destination: z.boolean(),
});
const routePlanSchema = z.object({
  planner_id: z.string(),
  map_id: z.string(),
  map_revision: z.number().int().positive(),
  map_digest: z.string(),
  source_body_id: z.string(),
  source_place_id: z.string(),
  destination_place_id: z.string(),
  destination_capability: capabilitySchema.nullable(),
  destination_body_id: z.string(),
  legs: z.array(
    z.object({
      segment_id: z.string(),
      body_id: z.string(),
      from: z.string(),
      to: z.string(),
      from_pose: poseSchema,
      to_pose: poseSchema,
      arrival_radius_m: z.number(),
      required_capabilities: z.array(capabilitySchema),
      max_speed_mps: z.number(),
      distance_m: z.number(),
    }),
  ),
  transfers: z.array(
    z.object({
      place_id: z.string(),
      source_body_id: z.string(),
      target_body_id: z.string(),
      before_leg_index: z.number(),
      reason: z.string(),
    }),
  ),
  distance_m: z.number(),
  explanation: z.array(z.string()),
  assessments: z.array(assessmentSchema),
});
export const routeProposalSchema = z.object({
  id: z.string(),
  digest: z.string(),
  request: objectiveSchema,
  plan: routePlanSchema.nullable(),
  failure: z
    .object({ code: z.string(), message: z.string(), assessments: z.array(assessmentSchema) })
    .nullable(),
  steps: z.array(
    z.object({
      title: z.string(),
      command: skillCommandSchema,
      continue_on_missing_marker: z.boolean(),
    }),
  ),
  step_body_ids: z.array(z.string()),
  created_at: z.string(),
  expires_at: z.string(),
  status: z.enum(['pending', 'blocked', 'approved', 'invalidated']),
  round_id: z.string().nullable(),
  adaptive: z
    .object({
      conditions_revision: z.number().int().nonnegative(),
      blocked_segment_ids: z.array(z.string()),
      step_offset: z.number().int().nonnegative(),
      parent_plan_id: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
});

export type SemanticMap = z.infer<typeof semanticMapSchema>;
export type RouteProposal = z.infer<typeof routeProposalSchema>;
export type RoutePlan = z.infer<typeof routePlanSchema>;
export type RouteAssessment = z.infer<typeof assessmentSchema>;
export type RouteObjective = z.infer<typeof objectiveSchema>;
