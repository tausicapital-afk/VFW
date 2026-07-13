import type { CookieOptions } from 'express';

export const SESSION_COOKIE = 'vfw_session';

/**
 * Session cookie options.
 *
 * The frontend serves the SPA *and* reverse-proxies `/api` to this API
 * (see `frontend/nginx.conf.template`), so the browser only ever talks to a
 * single origin and the session cookie is always **first-party**. That makes
 * SameSite=Lax correct and safer — nothing is cross-site, so none of Safari's
 * ITP or Chrome's third-party-cookie phase-out applies.
 *
 * Escape hatch: set `COOKIE_SAMESITE=none` only for a genuinely cross-site
 * deployment (SPA and API on different sites, no proxy). None is ignored by
 * browsers unless the cookie is also Secure, so we force Secure in that case.
 * `COOKIE_DOMAIN` can pin the cookie to a shared parent domain if ever needed.
 */
export function sessionCookie(maxAgeMs?: number): CookieOptions {
  const isProd = process.env.NODE_ENV === 'production';
  const domain = process.env.COOKIE_DOMAIN || undefined;
  const sameSite =
    (process.env.COOKIE_SAMESITE as CookieOptions['sameSite']) || 'lax';

  return {
    httpOnly: true,
    secure: isProd || sameSite === 'none',
    sameSite,
    domain,
    path: '/',
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  };
}
