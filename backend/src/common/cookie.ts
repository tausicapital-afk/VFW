import type { CookieOptions } from 'express';

export const SESSION_COOKIE = 'vfw_session';

/**
 * Session cookie options.
 *
 * The important subtlety is SameSite. Browsers decide "same site" by the
 * registrable domain, and `up.railway.app` is on the Public Suffix List — so
 * `vfw-web.up.railway.app` and `vfw-api.up.railway.app` are *different sites*.
 * On Railway's default domains the session is therefore a third-party cookie,
 * which needs SameSite=None + Secure, and which Safari's ITP and Chrome's
 * third-party cookie phase-out will block outright.
 *
 * The fix is a custom domain: serve the app from `app.example.com` and the API
 * from `api.example.com`, then set COOKIE_DOMAIN=.example.com. Both are now the
 * same site, SameSite=Lax applies, and nothing is third-party. Do that before
 * going live; the default-domain path works today but is on borrowed time.
 */
export function sessionCookie(maxAgeMs?: number): CookieOptions {
  const isProd = process.env.NODE_ENV === 'production';
  const domain = process.env.COOKIE_DOMAIN || undefined;

  // With a shared parent domain the cookie is first-party, so Lax is both
  // sufficient and safer. Without one, cross-site delivery requires None.
  const sameSite = domain ? 'lax' : isProd ? 'none' : 'lax';

  return {
    httpOnly: true,
    secure: isProd, // SameSite=None is ignored unless the cookie is Secure.
    sameSite,
    domain,
    path: '/',
    ...(maxAgeMs !== undefined ? { maxAge: maxAgeMs } : {}),
  };
}
