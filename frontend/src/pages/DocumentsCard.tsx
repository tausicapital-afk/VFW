import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { can } from '../lib/acl';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import type { DocumentType, SignatureRequestSummary, SubmissionDocument } from '../lib/types';
import { fmtSize, TYPE_LABEL, uploadDocument } from '../lib/uploads';

const SIGNATURE_STATUS_LABEL: Record<SignatureRequestSummary['status'], string> = {
  SENT: 'Sent for signature',
  DELIVERED: 'Opened by signer',
  COMPLETED: 'Signed',
  DECLINED: 'Declined',
  VOIDED: 'Voided',
};
// Reuses the submission-status pill palette (APPROVED = green, RETURNED = red,
// PENDING = amber) rather than inventing a fourth colour set for one card.
const SIGNATURE_STATUS_PILL: Record<SignatureRequestSummary['status'], string> = {
  SENT: 'PENDING',
  DELIVERED: 'PENDING',
  COMPLETED: 'APPROVED',
  DECLINED: 'RETURNED',
  VOIDED: 'RETURNED',
};

/**
 * Documents attached to a submission. The upload is a two-step dance so the file
 * never passes through our API: presign → PUT straight to R2 → record the row.
 *
 * Each document can also be sent out for signature via DocuSign — the same
 * kind of outward-facing act as emailing an invoice or a portal link, so it
 * is gated by `email.send` rather than anything document-specific (see the
 * comment on that permission in backend/src/common/acl.ts).
 */
export function DocumentsCard({ submissionId }: { submissionId: string }) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<DocumentType>('contract');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: docs, isLoading } = useQuery({
    queryKey: ['submission', submissionId, 'documents'],
    queryFn: () => api.get<SubmissionDocument[]>(`/api/submissions/${submissionId}/documents`),
  });

  const { data: signatureRequests } = useQuery({
    queryKey: ['submission', submissionId, 'signature-requests'],
    queryFn: () => api.get<SignatureRequestSummary[]>(`/api/submissions/${submissionId}/signature-requests`),
  });

  // The most recent request per source document — a re-send after a decline
  // creates a second row, and the newest is the one worth showing.
  const latestByDocument = new Map<string, SignatureRequestSummary>();
  for (const r of signatureRequests ?? []) {
    const prev = latestByDocument.get(r.documentId);
    if (!prev || r.sentAt > prev.sentAt) latestByDocument.set(r.documentId, r);
  }

  const sendForSignature = useMutation({
    mutationFn: (docId: string) =>
      api.post<SignatureRequestSummary>(`/api/submissions/${submissionId}/documents/${docId}/send-for-signature`),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['submission', submissionId, 'signature-requests'] });
      void qc.invalidateQueries({ queryKey: ['submission', submissionId, 'audit'] });
    },
    onError: (e: Error) => setError(e.message),
  });

  async function upload(file: File) {
    setError(null);
    setBusy(true);
    try {
      await uploadDocument(submissionId, file, type);
      void qc.invalidateQueries({ queryKey: ['submission', submissionId, 'documents'] });
      void qc.invalidateQueries({ queryKey: ['submission', submissionId, 'audit'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const download = useMutation({
    mutationFn: (docId: string) =>
      api.get<{ url: string }>(`/api/submissions/${submissionId}/documents/${docId}/download`),
    onSuccess: ({ url }) => window.open(url, '_blank', 'noopener'),
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="hd">
        <h3>Documents</h3>
        <div className="sp" />
        <span className="sm mut">Contract, PO and receipt attach here.</span>
      </div>
      <div className="bd">
        <div className="rowflex upload" style={{ gap: 8, marginBottom: 12 }}>
          <select value={type} onChange={(e) => setType(e.target.value as DocumentType)} disabled={busy}>
            {(Object.keys(TYPE_LABEL) as DocumentType[]).map((t) => (
              <option key={t} value={t}>{TYPE_LABEL[t]}</option>
            ))}
          </select>
          <input
            ref={fileRef}
            type="file"
            disabled={busy}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }}
          />
          {busy && <span className="sm mut">Uploading…</span>}
        </div>

        {error && <div className="note bad" style={{ marginBottom: 12 }}>{error}</div>}

        {isLoading ? (
          <p className="sm mut">Loading…</p>
        ) : !docs?.length ? (
          <div className="empty">
            <h3>No documents yet</h3>
            <p>Attach the signed contract, PO or receipt for this sale.</p>
          </div>
        ) : (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr><th>Type</th><th>File</th><th>Uploaded</th><th>Signature</th><th /></tr>
              </thead>
              <tbody>
                {docs.map((d) => {
                  const sig = latestByDocument.get(d.id);
                  // Only offer (re)sending while nothing is outstanding on this
                  // exact document — a live SENT/DELIVERED request already
                  // covers it, and a completed one is done. A DECLINED or
                  // VOIDED one is exactly when a re-send is the point.
                  const canSend =
                    can('email.send', user?.role) && (!sig || sig.status === 'DECLINED' || sig.status === 'VOIDED');
                  return (
                    <tr key={d.id}>
                      <td className="sm">{TYPE_LABEL[d.type] ?? d.type}</td>
                      <td className="sm">
                        {d.filename}
                        {d.size ? <span className="mut"> · {fmtSize(d.size)}</span> : null}
                      </td>
                      <td className="sm mut">
                        {fmtDate(d.uploadedAt)}{d.uploadedBy ? ` · ${d.uploadedBy.name}` : ''}
                      </td>
                      <td className="sm">
                        {sig ? (
                          <span className={'pill ' + SIGNATURE_STATUS_PILL[sig.status]}>
                            {SIGNATURE_STATUS_LABEL[sig.status]}
                          </span>
                        ) : (
                          <span className="mut">—</span>
                        )}
                      </td>
                      <td>
                        <div className="rowflex" style={{ gap: 8, justifyContent: 'flex-end' }}>
                          {canSend && (
                            <button
                              className="btn sm"
                              disabled={sendForSignature.isPending}
                              onClick={() => sendForSignature.mutate(d.id)}
                            >
                              {sendForSignature.isPending ? 'Sending…' : sig ? 'Resend' : 'Send for signature'}
                            </button>
                          )}
                          <button
                            className="btn sm"
                            disabled={download.isPending}
                            onClick={() => download.mutate(d.id)}
                          >
                            Download
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
