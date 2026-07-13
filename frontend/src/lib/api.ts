/**
 * The session lives in an httpOnly cookie, so there is no token to attach and
 * nothing for a script on this page to steal. Every call just has to opt in to
 * sending credentials.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// In production the SPA and the API live on separate Railway domains, so calls
// need an absolute base. In dev this is empty and Vite proxies /api to the
// backend (see vite.config.ts), which keeps the session cookie same-site.
const API_BASE = import.meta.env.VITE_API_BASE ?? '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    // Nest returns string | string[] for validation failures.
    const raw = (body as { message?: string | string[] }).message;
    const message = Array.isArray(raw) ? raw.join('. ') : (raw ?? res.statusText);
    throw new ApiError(res.status, message);
  }

  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
};
