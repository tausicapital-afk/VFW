import { api } from './api';
import type { DocumentType } from './types';

export const TYPE_LABEL: Record<DocumentType, string> = {
  contract: 'Signed contract',
  po: 'Purchase order',
  receipt: 'Receipt',
  other: 'Other',
};

type PresignResponse = {
  uploadUrl: string;
  storageKey: string;
  method: 'PUT';
  headers: Record<string, string>;
};

/**
 * Attach one file to an existing submission. The upload is a two-step dance so
 * the file never passes through our API: presign → PUT straight to R2 → record
 * the row. Shared by the document card (post-hoc uploads) and the new-submission
 * form (files staged before the submission exists, flushed once it does).
 */
export async function uploadDocument(
  submissionId: string,
  file: File,
  type: DocumentType,
): Promise<void> {
  // 1. Ask our API for a short-lived URL to push the bytes to.
  const presigned = await api.post<PresignResponse>(
    `/api/submissions/${submissionId}/documents/presign`,
    {
      type,
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      size: file.size,
    },
  );

  // 2. PUT the file straight to R2 — no credentials, not through our API.
  const put = await fetch(presigned.uploadUrl, {
    method: 'PUT',
    headers: presigned.headers,
    body: file,
  });
  if (!put.ok) throw new Error(`Upload to storage failed (${put.status})`);

  // 3. Now that the bytes are in R2, record the row that points at them.
  await api.post(`/api/submissions/${submissionId}/documents`, {
    type,
    filename: file.name,
    storageKey: presigned.storageKey,
    contentType: file.type || undefined,
    size: file.size,
  });
}

export function fmtSize(bytes: number | null): string {
  if (!bytes) return '';
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${Math.round(bytes / 1e3)} KB`;
  return `${bytes} B`;
}
