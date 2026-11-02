import { z } from 'zod';
import { routeConditionSchema, routeConditionsSchema } from '../features/navigation/conditions';
import { routeReplanSchema } from '../features/navigation/replans';
import { capabilityRecordingSchema, capabilityVideoSchema } from './capabilityTypes';

export const adaptiveRecordingSchema = z
  .object({
    ...capabilityRecordingSchema.shape,
    schema: z.literal('lattice.adaptive-route.v1'),
    mission_duration_s: z.number().finite().positive(),
    objective: routeReplanSchema.shape.original_objective,
    initial_plan: capabilityRecordingSchema.shape.plan,
    conditions: routeConditionsSchema,
    condition_observation: routeConditionSchema,
    replan: routeReplanSchema,
    lidar_scan: z.object({
      file: z.literal('adaptive-blockage-scan.json'),
      sha256: z.string().length(64),
      samples: z.number().int().positive(),
      sensor_frame_id: z.string(),
      scope: z.string(),
    }),
    obstacle: z.object({
      model_name: z.string(),
      pose: z.object({ x: z.number(), y: z.number(), z: z.number() }),
      size: z.object({
        x: z.number().positive(),
        y: z.number().positive(),
        z: z.number().positive(),
      }),
      created_at: z.string(),
      sdf_sha256: z.string().length(64),
      scope: z.string(),
    }),
    adaptation: z.object({
      case_name: z.enum(['blocked_center', 'blocked_offset']),
      blocked_segment_id: z.string(),
      completed_steps_preserved: z.number().int().positive(),
      repeated_inspections: z.literal(0),
      block_observed_s: z.number().finite().nonnegative(),
      replan_proposal_ms: z.number().finite().nonnegative(),
      replan_approved_s: z.number().finite().nonnegative(),
      hold_to_approval_s: z.number().finite().nonnegative(),
      source_drift_while_held_m: z.number().finite().nonnegative(),
      post_transfer_source_drift_m: z.number().finite().nonnegative(),
    }),
  })
  .refine(
    (run) =>
      run.replan.status === 'approved' &&
      run.replan.round_id === run.round_id &&
      run.replan.completed_steps.length === run.adaptation.completed_steps_preserved &&
      run.steps.length === run.step_body_ids.length &&
      run.mission_duration_s <= run.duration_s &&
      run.condition_observation.status === 'blocked' &&
      run.condition_observation.body_id === run.handoff.source_body_id &&
      run.condition_observation.evidence?.scan_sha256 === run.lidar_scan.sha256 &&
      run.initial_plan.legs.some((leg) => leg.segment_id === run.adaptation.blocked_segment_id) &&
      !run.plan.legs.some((leg) => leg.segment_id === run.adaptation.blocked_segment_id) &&
      run.plan.destination_place_id === run.objective.route.destination_place_id &&
      run.replan.retained_observation_ids.every((id) =>
        run.observations.some((observation) => observation.id === id),
      ) &&
      JSON.stringify(run.steps.slice(0, run.replan.completed_steps.length)) ===
        JSON.stringify(run.replan.completed_steps),
    'Adaptive recording must preserve its completed work and bind a real blocked report to an approved replacement route.',
  );

export const adaptiveScanSchema = z.object({
  sensor_frame_id: z.string(),
  stamp_sec: z.number().int(),
  stamp_nanosec: z.number().int(),
  angle_min: z.number().finite(),
  angle_increment: z.number().finite().positive(),
  range_min: z.number().finite().nonnegative(),
  range_max: z.number().finite().positive(),
  sensor_map_pose: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    yaw: z.number().finite(),
  }),
  ranges: z.array(z.number().finite().nullable()).min(1).max(720),
});
export const adaptiveVideoSchema = capabilityVideoSchema.extend({
  video: capabilityVideoSchema.shape.video.extend({
    poster: z.literal('adaptive-quadruped.poster.png'),
  }),
});
export type AdaptiveRecording = z.infer<typeof adaptiveRecordingSchema>;
export type AdaptiveScan = z.infer<typeof adaptiveScanSchema>;
export type AdaptiveVideo = z.infer<typeof adaptiveVideoSchema>;
