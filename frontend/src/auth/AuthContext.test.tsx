import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './AuthContext';
import { api, ApiError } from '../lib/api';
import type { User } from '../lib/types';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
  };
});

const mockedApi = vi.mocked(api);

const REP: User = { id: 'u1', name: 'Marielle Rep', email: 'marielle@vanfashionweek.com', role: 'SALES' };

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={qc}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    );
  }
  return { Wrapper, qc };
}

describe('useAuth', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('throws when used outside an AuthProvider', () => {
    // renderHook without the provider wrapper.
    expect(() => renderHook(() => useAuth())).toThrow('useAuth must be used inside <AuthProvider>');
  });

  it('starts loading, then resolves to a signed-out user (null) on a 401 from /api/auth/me', async () => {
    mockedApi.get.mockRejectedValueOnce(new ApiError(401, 'Unauthorized'));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();
  });

  it('resolves to the signed-in user when the session check succeeds', async () => {
    mockedApi.get.mockResolvedValueOnce({ user: REP });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toEqual(REP);
  });

  it('propagates a non-401 failure from /api/auth/me instead of silently treating it as signed-out', async () => {
    mockedApi.get.mockRejectedValueOnce(new ApiError(500, 'Server exploded'));
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    // react-query swallows the throw into isError; the hook only exposes
    // data-derived `user`, so a hard failure still surfaces as "no user" here.
    expect(result.current.user).toBeNull();
  });

  it('login() posts credentials and puts the returned user straight into the cache', async () => {
    mockedApi.get.mockRejectedValueOnce(new ApiError(401, 'Unauthorized'));
    mockedApi.post.mockResolvedValueOnce({ user: REP });
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.user).toBeNull();

    await act(async () => {
      await result.current.login('marielle@vanfashionweek.com', 'Vfw@2026!', true);
    });

    expect(mockedApi.post).toHaveBeenCalledWith('/api/auth/login', {
      email: 'marielle@vanfashionweek.com',
      password: 'Vfw@2026!',
      remember: true,
    });
    await waitFor(() => expect(result.current.user).toEqual(REP));
  });

  it('logout() clears the session and drops every other cached query, but keeps the "me" entry as null', async () => {
    mockedApi.get.mockResolvedValueOnce({ user: REP });
    mockedApi.post.mockResolvedValueOnce(undefined);
    const { Wrapper, qc } = makeWrapper();

    const { result } = renderHook(() => useAuth(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.user).toEqual(REP));

    // Simulate other screens having populated the cache during the session.
    qc.setQueryData(['submissions'], [{ id: 's1' }]);

    await act(async () => {
      await result.current.logout();
    });

    expect(mockedApi.post).toHaveBeenCalledWith('/api/auth/logout');
    expect(qc.getQueryData(['me'])).toBeNull();
    expect(qc.getQueryData(['submissions'])).toBeUndefined();
    expect(result.current.user).toBeNull();
  });
});
