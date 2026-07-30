import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthContext';
import { api, ApiError } from '../lib/api';
import { Login } from './Login';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
  };
});

const mockedApi = vi.mocked(api);

function renderLogin() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}>
        <AuthProvider>
          <Login />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<Login />', () => {
  beforeEach(() => {
    // AuthProvider always probes the session on mount; nobody is signed in yet.
    mockedApi.get.mockRejectedValue(new ApiError(401, 'Unauthorized'));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('renders the sign-in form', () => {
    renderLogin();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByLabelText('Work email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('submits the entered credentials and shows a busy state while the request is in flight', async () => {
    const user = userEvent.setup();
    let resolveLogin!: (v: { user: unknown }) => void;
    mockedApi.post.mockReturnValueOnce(new Promise((resolve) => { resolveLogin = resolve; }));

    renderLogin();
    await user.type(screen.getByLabelText('Work email'), 'marielle@vanfashionweek.com');
    await user.type(screen.getByLabelText('Password'), 'Vfw@2026!');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(mockedApi.post).toHaveBeenCalledWith('/api/auth/login', {
      email: 'marielle@vanfashionweek.com',
      password: 'Vfw@2026!',
      remember: false,
    });
    expect(await screen.findByRole('button', { name: 'Signing in…' })).toBeDisabled();

    resolveLogin({ user: { id: 'u1', name: 'Marielle', email: 'marielle@vanfashionweek.com', role: 'SALES' } });
    // No navigation happens from Login itself (App swaps the tree once ['me']
    // resolves), so settling just means the in-flight request finished cleanly.
    await waitFor(() => expect(mockedApi.post).toHaveBeenCalledTimes(1));
  });

  it('shows the server error and re-enables the form when login fails', async () => {
    const user = userEvent.setup();
    mockedApi.post.mockRejectedValueOnce(new ApiError(401, 'Invalid email or password'));

    renderLogin();
    await user.type(screen.getByLabelText('Work email'), 'wrong@vanfashionweek.com');
    await user.type(screen.getByLabelText('Password'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Invalid email or password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
  });

  it('sends remember=true when "keep me signed in" is checked', async () => {
    const user = userEvent.setup();
    mockedApi.post.mockResolvedValueOnce({ user: { id: 'u1', name: 'M', email: 'm@x.com', role: 'SALES' } });

    renderLogin();
    await user.type(screen.getByLabelText('Work email'), 'm@x.com');
    await user.type(screen.getByLabelText('Password'), 'pw');
    await user.click(screen.getByLabelText('Keep me signed in for 30 days'));
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ remember: true })),
    );
  });
});
