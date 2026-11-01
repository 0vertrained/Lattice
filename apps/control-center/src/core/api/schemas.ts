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
  capabilities: z.array(capabilitySchema),
  last_seen: z.string(),
  adapter_version: z.string(),
});

export const skillCommandSchema = z.discriminatedUnion('type', [
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
]);

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
