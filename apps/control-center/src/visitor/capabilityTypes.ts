import { z } from 'zod';
import { observationSchema } from '../features/memory/observation';
import { routeProposalSchema, semanticMapSchema } from '../features/navigation/navigation';

export const capabilityRecordingSchema = z
  .object({
    schema: z.literal('lattice.capability-route.v1'),
    recorded_at: z.string(),
    duration_s: z.number().finite().positive(),
    outcome: z.literal('completed'),
    round_id: z.string(),
    digest: z.string(),
    anomaly_count: z.number().int().nonnegative(),
    route_plan_id: z.string(),
    map: semanticMapSchema,
    plan: routeProposalSchema.shape.plan.unwrap(),
    steps: routeProposalSchema.shape.steps,
    step_body_ids: z.array(z.string()),
    poses: z
      .array(
        z.object({
          t: z.number().finite(),
          body_id: z.string(),
          x: z.number().finite(),
          y: z.number().finite(),
          z: z.number().finite().nullable().optional(),
          yaw: z.number().finite(),
          status: z.string(),
        }),
      )
      .min(2),
    events: z.array(
      z.object({ t: z.number().finite(), title: z.string(), detail: z.string(), kind: z.string() }),
    ),
    observations: z
      .array(
        observationSchema.extend({
          image: z.string().regex(/^[a-zA-Z0-9_-]+\.jpg$/),
          observer_pose: observationSchema.shape.observer_pose
            .unwrap()
            .extend({ z: z.number().finite().nullable().optional() })
            .nullable(),
        }),
      )
      .min(2),
    distance_by_body_m: z.record(z.string(), z.number().finite().nonnegative()),
    handoff: z.object({
      id: z.string(),
      source_body_id: z.string(),
      target_body_id: z.string(),
      context_digest: z.string(),
      completed_steps: z.number().int().nonnegative(),
      remaining_steps: z.number().int().positive(),
      context_acknowledged_at: z.string(),
      not_before_at: z.string(),
      approved_at: z.string(),
    }),
    quadruped: z.object({
      engine: z.string(),
      controller: z.string(),
      step_count: z.number().int().positive(),
      riser_height_m: z.number().finite().positive(),
      contact_steps: z.array(z.string()),
      max_tilt_rad: z.number().finite().nonnegative(),
      max_motor_torque_nm: z.number().finite().nonnegative(),
      final_base_z_m: z.number().finite(),
      final_navigation_z_m: z.number().finite(),
      foot_contacts_at_completion: z.array(
        z.object({
          foot: z.string(),
          surfaces: z.array(z.string()),
          normal_force_n: z.number().finite(),
        }),
      ),
    }),
  })
  .refine(
    (run) =>
      run.steps.length === run.step_body_ids.length &&
      run.handoff.source_body_id !== run.handoff.target_body_id,
    'Recording assignments must identify distinct source and receiving bodies.',
  );

export type CapabilityRecording = z.infer<typeof capabilityRecordingSchema>;

export const capabilityVideoSchema = z.object({
  source_kind: z.literal('recorded_gateway_physics'),
  source_round_id: z.string(),
  source_mission_ids: z.array(z.string()),
  source_sha256: z.string().length(64),
  source_provenance_sha256: z.string().length(64),
  map_digest: z.string().length(64),
  policy_commit: z.string(),
  policy_sha256: z.string().length(64),
  model_commit: z.string(),
  mujoco_version: z.string(),
  video: z.object({
    sha256: z.string().length(64),
    bytes: z.number().int().positive(),
    duration_s: z.number().positive(),
    fps: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    poster: z.literal('capability-quadruped.poster.png'),
  }),
});
export type CapabilityVideo = z.infer<typeof capabilityVideoSchema>;
