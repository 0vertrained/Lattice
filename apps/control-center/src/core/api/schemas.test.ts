import { describe, expect, it } from 'vitest';
import { bodySchema, missionSchema } from './schemas';

describe('API schemas', () => {
  it('rejects impossible battery values', () => {
    const result = bodySchema.safeParse({
      id: 'rover-r1',
      display_name: 'Rover R1',
      kind: 'rover',
      status: 'online',
      battery: 140,
      location: 'garage',
      capabilities: ['navigate'],
      last_seen: new Date().toISOString(),
      adapter_version: '0.1.0',
    });

    expect(result.success).toBe(false);
  });

  it('requires an active command to be explicit', () => {
    const result = missionSchema.safeParse({
      id: 'mission-test',
      title: 'Inspect garage',
      command: { type: 'inspect', location: 'garage' },
      status: 'assigned',
      assigned_body_id: 'rover-r1',
      progress_pct: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status_detail: null,
    });

    expect(result.success).toBe(false);
  });
});
