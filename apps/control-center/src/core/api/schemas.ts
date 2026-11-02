import { z } from 'zod';

export const capabilitySchema = z.enum([
  'navigate',
  'inspect',
  'follow',
  'carry',
  'stairs',
  'aerial',
  'rough_terrain',
]);

export const bodyStatusSchema = z.enum([
  'online',
  'offline',
  'docked',
  'charging',
  'faulted',
  'emergency_stopped',
]);

export const bodyKindSchema = z.enum([
  'rover',
  'quadruped',
  'drone',
  'humanoid',
  'spider',
  'simulation',
]);

export const bodySchema = z.object({
  id: z.string(),
  display_name: z.string(),
  kind: bodyKindSchema,
  status: bodyStatusSchema,
  battery: z.number().int().min(0).max(100),
  location: z.string(),
  pose: z
    .object({
      x: z.number().finite().min(-10000).max(10000),
      y: z.number().finite().min(-10000).max(10000),
      yaw: z.number().finite().min(-Math.PI).max(Math.PI),
      z: z.number().finite().min(-10000).max(10000).nullable().optional(),
    })
    .nullable()
    .optional(),
  capabilities: z.array(capabilitySchema),
  last_seen: z.string(),
  adapter_version: z.string(),
});

export const skillCommandSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('traverse_route'),
    traversal: z.object({
      map_id: z.string(),
      map_revision: z.number().int().positive(),
      map_digest: z.string(),
      segment_id: z.string(),
      from: z.object({
        id: z.string(),
        pose: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }),
        arrival_radius_m: z.number().positive(),
      }),
      to: z.object({
        id: z.string(),
        pose: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }),
        arrival_radius_m: z.number().positive(),
      }),
      required_capabilities: z.array(capabilitySchema),
      max_speed_mps: z.number().positive(),
    }),
  }),
  z.object({
    type: z.literal('navigate'),
    destination: z.string().min(1).max(100),
    max_speed_mps: z.number().min(0.05).max(3),
  }),
  z.object({
    type: z.literal('inspect'),
    location: z.string().min(1).max(100),
  }),
  z.object({
    type: z.literal('follow'),
    target: z.string().min(1).max(100),
    max_distance_m: z.number().min(0.5).max(10),
  }),
  z.object({
    type: z.literal('carry'),
    item: z.string().min(1).max(100),
    destination: z.string().min(1).max(100),
    max_mass_kg: z.number().min(0.01).max(25),
  }),
  z.object({
    type: z.literal('aerial_inspect'),
    location: z.string().min(1).max(100),
    max_altitude_m: z.number().min(0.5).max(30),
  }),
  z.object({
    type: z.literal('traverse_rough_terrain'),
    destination: z.string().min(1).max(100),
  }),
]);

export const missionStatusSchema = z.enum([
  'queued',
  'assigned',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
  'recovery_required',
]);

export const evidenceSchema = z.object({
  model_id: z.string(),
  captured_at_ms: z.number().int(),
  frame_sha256: z.string().length(64),
  image_sha256: z.string().length(64),
  image_base64: z.string().max(54000),
  confidence_domain: z.string(),
  detections: z
    .array(
      z.object({
        label: z.literal('octagonal_safety_marker'),
        confidence: z.number().finite().min(0.8).max(1),
        box: z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number().int()]),
      }),
    )
    .max(16),
});

export const proposalSchema = z.object({
  id: z.string(),
  digest: z.string().length(64),
  created_at: z.string(),
  expires_at: z.string(),
  status: z.enum(['pending', 'approving', 'approved', 'failed', 'invalidated']),
  mission_id: z.string().nullable(),
  approved_at: z.string().nullable(),
  recovery_of: z.string().nullable().optional(),
  input: z.object({
    user_intent: z.string(),
    decision: z.enum(['ready', 'clarify', 'rejected']),
    command: skillCommandSchema.nullable(),
    model_id: z.string(),
    policy_version: z.string(),
    confidence: z.number().finite().min(0).max(1),
    rationale: z.string(),
  }),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const missionSchema = z.object({
  id: z.string(),
  title: z.string(),
  command: skillCommandSchema,
  status: missionStatusSchema,
  assigned_body_id: z.string().nullable(),
  active_command_id: z.string().nullable(),
  progress_pct: z.number().int().min(0).max(100),
  created_at: z.string(),
  updated_at: z.string(),
  status_detail: z.string().nullable(),
  evidence: evidenceSchema.nullable().optional(),
});

export const auditActorSchema = z.union([
  z.object({ operator: z.string() }),
  z.object({ service: z.string() }),
  z.object({ body: z.string() }),
]);

export const auditRecordSchema = z.object({
  occurred_at: z.string(),
  actor: auditActorSchema,
  event_type: z.string(),
  object_id: z.string(),
  metadata: z.unknown(),
});

export type Body = z.infer<typeof bodySchema>;
export type Mission = z.infer<typeof missionSchema>;
export type SkillCommand = z.infer<typeof skillCommandSchema>;
export type AuditRecord = z.infer<typeof auditRecordSchema>;

export interface CreateMissionRequest {
  readonly title: string;
  readonly command: SkillCommand;
}
