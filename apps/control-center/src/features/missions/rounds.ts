import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiClient } from '../../core/api/apiClient';
import { skillCommandSchema } from '../../core/api/schemas';

const stepSchema = z.object({
  title: z.string(),
  command: skillCommandSchema,
  continue_on_missing_marker: z.boolean(),
});
export const roundSchema = z.object({
  id: z.string(),
  digest: z.string(),
  steps: z.array(stepSchema),
  expires_at: z.string(),
  status: z.string(),
  current_step: z.number(),
  current_mission_id: z.string().nullable(),
  mission_ids: z.array(z.string()),
  anomaly_count: z.number(),
  route_plan_id: z.string().nullable().optional(),
});
export type Round = z.infer<typeof roundSchema>;
export type RoundStep = Round['steps'][number];

/** Rounds are shared by the rounds section and the rail's held count, which polls more slowly. */
export function useRounds(enabled: boolean, interval: number) {
  return useQuery({
    queryKey: ['rounds'],
    queryFn: async () => z.array(roundSchema).parse(await apiClient.request('/rounds')),
    enabled,
    refetchInterval: interval,
  });
}
