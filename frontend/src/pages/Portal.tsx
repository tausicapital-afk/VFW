import { useMutation, useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { downloadFile } from '../lib/export';
import { money, PAY_LABEL, STATUS_LABEL } from '../lib/format';
import type { PortalData, PortalSubmission } from '../lib/types';

const SIGNATURE_LABEL: Record<NonNullable<PortalSubmission['signature']>['status'], string> = {
  SENT: 'Contract sent for signature',
  DELIVERED: 'Contract opened',
  COMPLETED: 'Contract signed',
  DECLINED: 'Signature declined',
  VOIDED: 'Signature request withdrawn',
};

/**
 * The unauthenticated, token-gated contact portal — GET /api/portal/:token.
 * No cookie, no login, nothing but the token in the URL, which is why this
 * page lives outside <Shell>/<Guard> in App.tsx alongside /signup, /forgot
 * and /reset. It is read-only: there is no button here that writes anything,
 * because the server has nothing on this path that does either.
 *
 * A bad or expired link gets the same generic message either way — the
 * server does not distinguish "never existed" from "expired", and neither
 * does this screen.
 */
export function Portal() {
  const { token } = useParams<{ token: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['portal', token],
    queryFn: () => api.get<PortalData>(`/api/portal/${token}`),
    enabled: !!token,
    retry: false,
  });

  const download = useMutation({
    mutationFn: (s: PortalSubmission) =>
      downloadFile(`/api/portal/${token}/submissions/${s.id}/invoice.pdf`, `${s.invoiceNo ?? 'invoice'}.pdf`),
  });

  // A presigned R2 URL, not a file this app streams — see
  // PortalService.signedContractUrl. Opened directly rather than run through
  // downloadFile, same as every other presigned link in the console.
  const downloadSignedContract = useMutation({
    mutationFn: (s: PortalSubmission) =>
      api.get<{ url: string; filename: string }>(`/api/portal/${token}/submissions/${s.id}/signed-contract`),
    onSuccess: ({ url }) => window.open(url, '_blank', 'noopener'),
  });

  return (
    <section id="login">
      <div className="panel" style={{ maxWidth: 720, width: '100%' }}>
        <div style={{ marginBottom: 18 }}>
          <div className="mark" style={{ display: 'inline-block' }}>VFW</div>
        </div>

        {isLoading && (
          <div className="empty"><h3>Loading…</h3></div>
        )}

        {!isLoading && (error || !data) && (
          <div className="empty">
            <h3>This link is invalid or has expired</h3>
            <p>
              {error instanceof ApiError && error.status === 429
                ? 'Too many attempts from this connection. Try again shortly.'
                : 'Ask your VFW contact to send a fresh portal link.'}
            </p>
          </div>
        )}

        {!isLoading && data && (
          <>
            <h2>{data.contact.brand}</h2>
            <p className="hint">
              {data.contact.designer}
              {data.contact.company ? ` · ${data.contact.company}` : ''}
            </p>

            {data.submissions.length === 0 ? (
              <div className="empty" style={{ marginTop: 16 }}>
                <h3>No sales yet</h3>
                <p>Nothing has been submitted for this account so far.</p>
              </div>
            ) : (
              <div className="tbl-wrap" style={{ marginTop: 16 }}>
                <table>
                  <thead>
                    <tr>
                      <th>Ref</th>
                      <th>Show</th>
                      <th>Status</th>
                      <th className="num">Total</th>
                      <th className="num">Paid</th>
                      <th className="num">Balance</th>
                      <th>Payment</th>
                      <th>Contract</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.submissions.map((s) => (
                      <tr key={s.id}>
                        <td className="mono">{s.ref}</td>
                        <td className="sm">{s.event}<br /><span className="mut">{s.package}</span></td>
                        <td><span className={'pill ' + s.status}>{STATUS_LABEL[s.status]}</span></td>
                        <td className="num">{money(s.total, s.currency)}</td>
                        <td className="num">{money(s.paidAmount, s.currency)}</td>
                        <td className="num">{money(s.balance, s.currency)}</td>
                        <td className="sm">{PAY_LABEL[s.payStatus]}</td>
                        <td className="sm">{s.signature ? SIGNATURE_LABEL[s.signature.status] : '—'}</td>
                        <td>
                          <div className="rowflex" style={{ gap: 8, justifyContent: 'flex-end' }}>
                            {s.signature?.status === 'COMPLETED' && (
                              <button
                                className="btn sm"
                                disabled={downloadSignedContract.isPending}
                                onClick={() => downloadSignedContract.mutate(s)}
                              >
                                Signed contract
                              </button>
                            )}
                            {s.invoiceNo && (
                              <button
                                className="btn sm"
                                disabled={download.isPending}
                                onClick={() => download.mutate(s)}
                              >
                                Invoice PDF
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="hint" style={{ marginTop: 18 }}>
              This link was sent to you by VFW Management and shows only your own account.
            </p>
          </>
        )}
      </div>
    </section>
  );
}
