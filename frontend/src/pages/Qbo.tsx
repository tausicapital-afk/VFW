import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../lib/api';
import { fmtDate, money } from '../lib/format';
import type { Submission } from '../lib/types';
import { Page } from '../shell/Shell';

/**
 * The QuickBooks payload is an export *format*, not a change of record — it is
 * built here, on the client, from the same submission the server already priced.
 * Posting it (POST /api/submissions/:id/export) is the part that mutates state:
 * it moves APPROVED -> EXPORTED and stores the QBO document number. The OAuth
 * transport is out of scope and stubbed server-side.
 */
function qboPayload(s: Submission, docType: string): Record<string, unknown> {
  const lines: Record<string, unknown>[] = [
    {
      DetailType: 'SalesItemLineDetail',
      Amount: Number(s.packagePrice),
      Description: `${s.package.name} — up to ${s.package.looks} looks (${s.event.name})`,
      SalesItemLineDetail: {
        ItemRef: { value: s.package.id, name: s.package.name },
        Qty: 1,
        UnitPrice: Number(s.packagePrice),
        TaxCodeRef: { value: s.taxCode },
        ItemAccountRef: { value: s.glCode ?? undefined },
      },
    },
    ...s.addons.map((l) => ({
      DetailType: 'SalesItemLineDetail',
      Amount: Number(l.amount),
      Description: l.addon.name,
      SalesItemLineDetail: {
        ItemRef: { value: l.addonId, name: l.addon.name },
        Qty: l.qty,
      },
    })),
  ];
  if (Number(s.discountAmount) > 0) {
    lines.push({
      DetailType: 'DiscountLineDetail',
      Amount: Number(s.discountAmount),
      DiscountLineDetail: {
        PercentBased: s.discountType === 'PCT',
        DiscountPercent: s.discountType === 'PCT' ? Number(s.discountValue) : undefined,
      },
    });
  }
  const doc: Record<string, unknown> = {
    __apiTarget: `/v3/company/{realmId}/${docType === 'Invoice' ? 'invoice' : 'salesreceipt'}`,
    DocNumber: s.invoiceNo ?? '(auto)',
    TxnDate: new Date().toISOString().slice(0, 10),
    CurrencyRef: { value: s.currency },
    CustomerRef: { name: s.contact.company || s.contact.brand },
    BillEmail: { Address: s.contact.email ?? undefined },
    Line: lines,
    TxnTaxDetail: {
      TxnTaxCodeRef: { value: s.taxCode },
      TotalTax: Number(s.taxAmount),
    },
    DepartmentRef: { value: s.department ?? undefined },
    PrivateNote: `Rep: ${s.rep.name} | Ref: ${s.ref}`,
    TotalAmt: Number(s.total),
  };
  if (docType === 'Sales Receipt') {
    doc.PaymentMethodRef = { value: s.paymentMethod ?? undefined };
    doc.DepositToAccountRef = { value: 'Undeposited Funds' };
  }
  return doc;
}

export function Qbo() {
  const { data, isLoading } = useQuery({
    queryKey: ['submissions'],
    queryFn: () => api.get<Submission[]>('/api/submissions'),
  });

  const [exporting, setExporting] = useState<Submission | null>(null);

  const ready = (data ?? []).filter((s) => s.status === 'APPROVED');
  const done = (data ?? []).filter((s) => s.status === 'EXPORTED');

  const readyTable = (rows: Submission[], exported: boolean) =>
    rows.length ? (
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Ref</th><th>Invoice</th><th>Customer</th>
              <th className="num">Total</th><th>{exported ? 'Exported' : 'Status'}</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id}>
                <td className="mono sm">{s.ref}</td>
                <td className="mono sm">{s.invoiceNo || '—'}</td>
                <td><b>{s.contact.brand}</b></td>
                <td className="num">{money(s.total, s.currency)}</td>
                <td className="sm">
                  {exported
                    ? fmtDate(s.exportedAt)
                    : <span className="pill APPROVED">Ready</span>}
                </td>
                <td>
                  <button className="btn sm" onClick={() => setExporting(s)}>
                    {exported ? 'View' : 'Export'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    ) : (
      <div className="empty">
        <h3>{exported ? 'Nothing exported yet' : 'Nothing waiting'}</h3>
        <p>{exported ? 'Approved records appear here once posted.' : 'Approve a submission to queue it for QuickBooks.'}</p>
      </div>
    );

  return (
    <Page crumb="Work" title="QuickBooks">
      <div className="kpis" style={{ marginBottom: 16 }}>
        <div className="kpi amber">
          <div className="lb">Ready to export</div>
          <div className="vl">{ready.length}</div>
          <div className="dt">Approved, awaiting posting</div>
        </div>
        <div className="kpi ok">
          <div className="lb">Exported</div>
          <div className="vl">{done.length}</div>
          <div className="dt">Posted to QuickBooks Online</div>
        </div>
      </div>

      <div className="note" style={{ marginBottom: 16 }}>
        Only approved submissions can be exported. The payload preview is the JSON body that would
        be posted to the QBO <span className="mono">invoice</span> or{' '}
        <span className="mono">salesreceipt</span> endpoint — the OAuth transport is stubbed.
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="hd"><h3>Ready to export</h3></div>
        {isLoading ? <div className="empty"><h3>Loading…</h3></div> : readyTable(ready, false)}
      </div>

      <div className="card">
        <div className="hd"><h3>Export ledger</h3></div>
        {readyTable(done, true)}
      </div>

      {exporting && (
        <ExportModal sub={exporting} onClose={() => setExporting(null)} />
      )}
    </Page>
  );
}

function ExportModal({ sub, onClose }: { sub: Submission; onClose: () => void }) {
  const qc = useQueryClient();
  const done = sub.status === 'EXPORTED';
  const suggested = sub.payStatus === 'PAID' ? 'Sales Receipt' : 'Invoice';
  const [docType, setDocType] = useState(suggested);
  const [error, setError] = useState<string | null>(null);

  const payload = useMemo(() => qboPayload(sub, docType), [sub, docType]);

  const run = useMutation({
    mutationFn: () => api.post(`/api/submissions/${sub.id}/export`, { docType }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['submissions'] });
      void qc.invalidateQueries({ queryKey: ['submission', sub.id] });
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  function download() {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${sub.invoiceNo || sub.ref}-qbo.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="modal" onClick={onClose}>
      <div className="box" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 680 }}>
        <div className="hd">
          <h3>{done ? `QuickBooks export — ${sub.invoiceNo || sub.ref}` : 'Export to QuickBooks Online'}</h3>
          <div className="sp" style={{ flex: 1 }} />
          <button className="btn sm" onClick={onClose}>Close</button>
        </div>
        <div className="bd">
          {done ? (
            <div className="note" style={{ marginBottom: 12 }}>
              Exported as <b>{sub.qbDocNumber}</b> on {fmtDate(sub.exportedAt)}.
            </div>
          ) : (
            <div className="fields" style={{ marginBottom: 12 }}>
              <div className="f">
                <label>Document type</label>
                <select value={docType} onChange={(e) => setDocType(e.target.value)}>
                  <option>Invoice</option>
                  <option>Sales Receipt</option>
                </select>
                <div className="help">
                  {sub.payStatus === 'PAID'
                    ? 'Paid in full — a sales receipt is the usual choice.'
                    : 'Balance outstanding — an invoice keeps the receivable open.'}
                </div>
              </div>
            </div>
          )}
          <div className="sm mut" style={{ marginBottom: 6 }}>Payload preview</div>
          <pre className="code" style={{ maxHeight: 320, overflow: 'auto' }}>
            {JSON.stringify(payload, null, 2)}
          </pre>
          {error && <div className="note bad" style={{ marginTop: 12 }}>{error}</div>}
        </div>
        <div className="ft">
          <button className="btn" onClick={download}>Download payload</button>
          {!done && (
            <button
              className="btn blue"
              disabled={run.isPending}
              onClick={() => { setError(null); run.mutate(); }}
            >
              {run.isPending ? 'Posting…' : 'Post & mark exported'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
