import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { Role, RolesResponse } from './types';

/**
 * The roles an admin maintains (Administration -> Roles), and a lookup from a
 * role key to its label. Any signed-in user may read the list: every screen
 * that names someone's role shows the label from here.
 */
export function useRoles() {
  const { data } = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<RolesResponse>('/api/roles'),
    staleTime: 5 * 60 * 1000,
  });
  const roles = data?.roles ?? [];
  return {
    roles,
    permissions: data?.permissions ?? [],
    label: (key: Role | null | undefined) => roles.find((r) => r.key === key)?.label ?? key ?? '',
  };
}
