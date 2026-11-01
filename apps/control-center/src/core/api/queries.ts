import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from './apiClient';
import type { CreateMissionRequest } from './schemas';

export const queryKeys = {
  bodies: ['bodies'] as const,
  missions: ['missions'] as const,
  audit: ['audit'] as const,
};

export function useBodies(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.bodies,
    queryFn: () => apiClient.listBodies(),
    enabled,
    refetchInterval: 2_000,
  });
}

export function useMissions(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.missions,
    queryFn: () => apiClient.listMissions(),
    enabled,
    refetchInterval: 2_000,
  });
}

export function useAudit(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.audit,
    queryFn: () => apiClient.listAudit(),
    enabled,
    refetchInterval: 5_000,
  });
}

export function useCreateMission() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateMissionRequest) => apiClient.createMission(request),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.missions });
      await queryClient.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}

export function useReassignUnavailable() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.reassignUnavailable(),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.missions });
      await queryClient.invalidateQueries({ queryKey: queryKeys.audit });
    },
  });
}
