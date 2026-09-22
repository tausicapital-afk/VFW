import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api } from '../lib/api';
import type { PortalData } from '../lib/types';
import { Portal } from './Portal';

/**
 * The unauthenticated, token-gated contact portal — this only covers the
 * "Pay now" action added for online payment collection (Stripe). The rest of
 * the page (loading, invalid-token, invoice download) is unit-covered on the
 * backend side (portal.spec.ts / portal.service.spec.ts); this is here
 * because the redirect-on-success behaviour is a frontend-only concern.
 */
vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
  };
});

const mockedApi = vi.mocked(api);

const PORTAL_DATA: PortalData = {
  contact: { brand: 'Maison X', designer: 'Jamie Lee', company: null },
  submissions: [
    {
      id: 's1', ref: 'VFW-0001', status: 'APPROVED', currency: 'USD',
      total: '1000.00', paidAmount: '500.00', balance: '500.00', payStatus: 'PARTIAL',
      invoiceNo: 'VFW-2041', event: 'Fall Show', package: 'Bronze Package',
      showDate: null, createdAt: '2026-01-01T00:00:00.000Z', signature: null,
    },
  ],
};

function renderPortal(initialPath = '/portal/tok123') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/portal/:token" element={<Portal />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<Portal /> — Pay now', () => {
  let originalLocation: Location;

  beforeEach(() => {
    originalLocation = window.location;
    // Replace with a plain, writable stand-in so setting `.href` here never
    // triggers jsdom's real (unimplemented) navigation — see the comment on
    // jsdom "Not implemented: navigation" in other suites in this repo.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).location;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).location = { ...originalLocation, href: '' };
  });

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).location = originalLocation;
    vi.resetAllMocks();
  });

  it('shows a Pay now button for a submission with an outstanding balance', async () => {
    mockedApi.get.mockResolvedValue(PORTAL_DATA);
    renderPortal();

    expect(await screen.findByRole('button', { name: 'Pay now' })).toBeInTheDocument();
  });

  it('does not show Pay now once the balance is settled', async () => {
    mockedApi.get.mockResolvedValue({
      ...PORTAL_DATA,
      submissions: [{ ...PORTAL_DATA.submissions[0], balance: '0.00', payStatus: 'PAID' }],
    });
    renderPortal();

    await screen.findByText('VFW-0001');
    expect(screen.queryByRole('button', { name: 'Pay now' })).not.toBeInTheDocument();
  });

  it('starts a Checkout Session and redirects the browser to the Stripe-hosted URL', async () => {
    mockedApi.get.mockResolvedValue(PORTAL_DATA);
    mockedApi.post.mockResolvedValue({ url: 'https://checkout.stripe.com/pay/cs_test_123' });
    renderPortal();

    const payButton = await screen.findByRole('button', { name: 'Pay now' });
    fireEvent.click(payButton);

    await waitFor(() =>
      expect(mockedApi.post).toHaveBeenCalledWith(
        '/api/payments/portal/tok123/submissions/s1/checkout-session',
      ),
    );
    await waitFor(() => expect(window.location.href).toBe('https://checkout.stripe.com/pay/cs_test_123'));
  });

  it('shows the server error and leaves the button usable again if starting checkout fails', async () => {
    mockedApi.get.mockResolvedValue(PORTAL_DATA);
    mockedApi.post.mockRejectedValue(new Error('Set the Stripe secret key and webhook signing secret under Administration → Configuration first.'));
    renderPortal();

    const payButton = await screen.findByRole('button', { name: 'Pay now' });
    fireEvent.click(payButton);

    expect(await screen.findByText(/Stripe secret key/i)).toBeInTheDocument();
    expect(window.location.href).toBe('');
  });

  it('shows a brief acknowledgement when Stripe redirects back with payment=success', async () => {
    mockedApi.get.mockResolvedValue(PORTAL_DATA);
    renderPortal('/portal/tok123?payment=success');

    expect(await screen.findByText(/Payment received by Stripe/i)).toBeInTheDocument();
  });
});
