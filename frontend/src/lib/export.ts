import { ApiError } from './api';

export const EXPORT_FORMATS = ['pdf', 'xlsx', 'csv'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const FORMAT_LABEL: Record<ExportFormat, { label: string; hint: string; ic: string }> = {
  pdf: { label: 'PDF', hint: 'Print-ready report', ic: '▤' },
  xlsx: { label: 'Excel', hint: 'Formulas and filters', ic: '▦' },
  csv: { label: 'CSV', hint: 'Plain data, any tool', ic: '≡' },
};

const API_BASE = import.meta.env.VITE_API_BASE ?? '';

/**
 * The screen's filters, forwarded to the dataset so the file holds what the
 * table holds. The server declares which keys exist and validates them (see
 * ExportQueryDto) — an unknown one is a 400, not a silently ignored param.
 */
export type ExportParams = Record<string, string | number | undefined | null>;

/** The server names the file; fall back only if the header is missing. */
function filenameFrom(header: string | null, dataset: string, format: ExportFormat): string {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? `${dataset}.${format}`;
}

/**
 * Pull an export and hand it to the browser as a download.
 *
 * Deliberately not `api.get`: the response is bytes, not JSON, and the session
 * cookie still has to travel — which is the only reason this cannot simply be an
 * <a href>. The rows the file contains are decided entirely by the server, from
 * the same scope rules as the screen the button sits on.
 */
export async function downloadExport(
  dataset: string,
  format: ExportFormat,
  params: ExportParams = {},
): Promise<void> {
  // The server runs in UTC and the table on screen is rendered in the browser's
  // zone. Send the zone, or an evening sale exports dated the day before the row
  // it was pulled from. See ExportQueryDto.
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const query = new URLSearchParams({ format, ...(tz ? { tz } : {}) });

  // The screen's filters. Empty strings are how a cleared <select> and an empty
  // search box read, and they are not filters — sending them would narrow the
  // file to nothing on a screen that is showing everything.
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }

  const res = await fetch(`${API_BASE}/api/export/${dataset}?${query}`, {
    credentials: 'include',
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const raw = (body as { message?: string | string[] }).message;
    const message = Array.isArray(raw) ? raw.join('. ') : (raw ?? res.statusText);
    throw new ApiError(res.status, message);
  }

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filenameFrom(res.headers.get('Content-Disposition'), dataset, format);
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately can cancel the download in Safari; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
