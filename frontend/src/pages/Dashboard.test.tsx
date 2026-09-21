import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthContext';
import { api } from '../lib/api';
import { TestDataProvider } from '../lib/testData';
import type { Submission, User } from '../lib/types';
import { ThemeProvider } from '../theme/ThemeContext';
import { ToastProvider } from '../shell/Toast';
import { Dashboard } from './Dashboard';

vi.mock('../lib/api', async () => {
  const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api');
  return {
    ...actual,
    api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() },
  };
});

const mockedApi = vi.mocked(api);

// jsdom has no ResizeObserver, which recharts' <ResponsiveContainer> needs to
// measure its box. A minimal stub is enough for it to render without throwing;
// the 0x0 layout it reports is fine for a render-only test like this one.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

const SALES_USER: User = { id: 'u1', name: 'Rep One', email: 'rep@vanfashionweek.com', role: 'SALES' };

function submission(overrides: Partial<Submission> = {}): Submission {
  return {
    id: 's1', ref: 'VFW-0001', status: 'APPROVED', currency: 'CAD',
    packageNameOverride: null, packageLooksOverride: null, packageBlurbOverride: null,
    packagePriceOverride: null, packageCustomized: false, packagePrice: '1000.00',
    addonTotal: '0.00', subtotal: '1000.00', discountType: 'AMT', discountValue: '0.00',
    discountAmount: '0.00', taxable: '1000.00', taxCode: 'GST', taxRate: '0.05',
    taxAmount: '50.00', total: '1050.00', deposit: '0.00', paidAmount: '500.00',
    balance: '550.00', payStatus: 'PARTIAL', commissionPct: '10.00', commissionAmount: '100.00',
    notes: null, showDate: '2026-10-01', paymentMethod: null, glCode: null, costCentre: null,
    department: null, invoiceNo: null, qbDocNumber: null, qboInvoiceId: null, qboSyncError: null,
    voidedFrom: null, voidedAt: null, rejectReason: null, returnNote: null,
    submittedAt: '2026-09-01T00:00:00.000Z', approvedAt: '2026-09-02T00:00:00.000Z', exportedAt: null,
    rep: { id: 'u1', name: 'Rep One', colour: '#2F6BFF' },
    contact: { id: 'c1', brand: 'Brand Co', designer: 'A Designer', company: null, email: null, country: null },
    event: {
      id: 'e1', brand: 'VFW', name: 'Fall Show', season: '2026F', venue: null,
      start: '2026-10-01', end: '2026-10-02', cityId: 'city1',
      city: { id: 'city1', name: 'Vancouver', country: 'CA', currency: 'CAD' },
    },
    package: { id: 'p1', brand: 'VFW', name: 'Runway Package', looks: 8, blurb: null, taxCode: 'GST', glCode: '4000', listValue: null, cap: null, prices: [] },
    addons: [], payments: [], installments: [],
    tax: { code: 'GST', label: 'GST', rate: '0.05', note: null },
    ...overrides,
  };
}

function renderDashboard() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <ToastProvider>
          <TestDataProvider>
            <MemoryRouter initialEntries={['/']}>
              <AuthProvider>
                <Dashboard />
              </AuthProvider>
            </MemoryRouter>
          </TestDataProvider>
        </ToastProvider>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe('<Dashboard />', () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it('renders the KPI strip and the charts once submissions load', async () => {
    mockedApi.get.mockImplementation(async (url: string) => {
      if (url === '/api/auth/me') return { user: SALES_USER };
      if (url === '/api/submissions') {
        return [
          submission({ id: 's1', status: 'APPROVED' }),
          submission({ id: 's2', status: 'PENDING', balance: '0.00' }),
          submission({ id: 's3', status: 'REJECTED', balance: '0.00' }),
        ];
      }
      if (url === '/api/fx') return { rates: { CAD: 1 }, source: 'manual', asOf: '2026-09-01' };
      throw new Error(`Unexpected GET ${url}`);
    });

    renderDashboard();

    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();

    // The KPI strip is unchanged.
    await waitFor(() => expect(screen.getByText('My net revenue')).toBeInTheDocument());

    // The three new charts render their card headers. A SALES role sees its
    // own numbers only, which is what /api/submissions already returned scoped.
    expect(await screen.findByText('My revenue trend')).toBeInTheDocument();
    expect(screen.getByText('Submission status')).toBeInTheDocument();
    expect(screen.getByText('Top packages')).toBeInTheDocument();
  });
});
