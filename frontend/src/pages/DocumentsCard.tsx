import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import type { DocumentType, SubmissionDocument } from '../lib/types';
import { fmtSize, TYPE_LABEL, uploadDocument } from '../lib/uploads';

/**
 * Documents attached to a submission. The upload is a two-step dance so the file
 * never passes through our API: presign → PUT straight to R2 → record the row.
 */
export function DocumentsCard({ submissionId }: { submissionId: string }) {
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [type, setType] = useState<DocumentType>('contract');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data: docs, isLoading } = useQuery({
    queryKey: ['submission', submissionId, 'documents'],
    queryFn: () => api.get<SubmissionDocument[]>(`/api/submissions/${submissionId}/documents`),
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
                <tr><th>Type</th><th>File</th><th>Uploaded</th><th /></tr>
              </thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td className="sm">{TYPE_LABEL[d.type] ?? d.type}</td>
                    <td className="sm">
                      {d.filename}
                      {d.size ? <span className="mut"> · {fmtSize(d.size)}</span> : null}
                    </td>
                    <td className="sm mut">
                      {fmtDate(d.uploadedAt)}{d.uploadedBy ? ` · ${d.uploadedBy.name}` : ''}
                    </td>
                    <td>
                      <button
                        className="btn sm"
                        disabled={download.isPending}
                        onClick={() => download.mutate(d.id)}
                      >
                        Download
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
