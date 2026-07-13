import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useContext, type ReactNode } from 'react';
import { api, ApiError } from '../lib/api';
import type { User } from '../lib/types';

interface AuthValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string, remember: boolean) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();

  // The session is a cookie we cannot read, so the only way to know whether we
  // are signed in is to ask the server. A 401 here is the expected answer for a
  // signed-out visitor, not an error worth retrying.
  const { data, isLoading } = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const { user } = await api.get<{ user: User }>('/api/auth/me');
        return user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    retry: false,
    staleTime: 5 * 60 * 1000,
  });

  const value: AuthValue = {
    user: data ?? null,
    loading: isLoading,
    async login(email, password, remember) {
      const { user } = await api.post<{ user: User }>('/api/auth/login', {
        email, password, remember,
      });
      qc.setQueryData(['me'], user);
    },
    async logout() {
      await api.post('/api/auth/logout');
      // Drop every cached query, not just the session: the next user to sign in
      // on this browser must never see the previous one's submissions.
      qc.clear();
      qc.setQueryData(['me'], null);
    },
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth must be used inside <AuthProvider>');
  return v;
}
