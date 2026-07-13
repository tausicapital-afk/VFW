import { randomUUID } from 'node:crypto';
import type { Params } from 'nestjs-pino';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Structured request logging.
 *
 * The rule this file exists to enforce: **a secret must never reach a log
 * line.** Logs get shipped, tailed, pasted into tickets and read by people who
 * are not supposed to be able to sign in as an accountant. A session cookie in
 * a log is a session anyone holding the log can replay.
 *
 * Three things are therefore removed before anything is written:
 *
 *   - `cookie` / `set-cookie` headers — these carry `vfw_session`, a live JWT.
 *   - `authorization` headers — bearer tokens.
 *   - request bodies — pino-http does not log them by default, and we do not
 *     turn that on. A body is where a password lives. There is no redaction
 *     rule to get wrong if the body is never serialized in the first place.
 *
 * Redaction is done with pino's `redact`, which operates on the serialized
 * object, so it holds even if a header is added upstream that we did not plan
 * for. The header allowlist below is a second, independent line of defence: the
 * serializer only copies headers we named, so an unforeseen `x-auth-whatever`
 * is dropped rather than logged and hoped to be harmless.
 */

/** Headers worth having when reconstructing a request. None of them are secret. */
const SAFE_REQUEST_HEADERS = [
  'host',
  'user-agent',
  'referer',
  'content-type',
  'content-length',
  'accept',
  'x-request-id',
] as const;

function pickSafeHeaders(headers: IncomingMessage['headers']) {
  const out: Record<string, unknown> = {};
  for (const h of SAFE_REQUEST_HEADERS) {
    if (headers[h] !== undefined) out[h] = headers[h];
  }
  return out;
}

export const loggerOptions: Params = {
  pinoHttp: {
    level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),

    // Human-readable locally; newline-delimited JSON in production, which is
    // what Railway's log viewer and any log shipper actually want.
    transport:
      process.env.NODE_ENV === 'production'
        ? undefined
        : { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } },

    // Correlate every line of one request. Honour an inbound id if a proxy set
    // one, so a trace can be followed across services.
    genReqId: (req: IncomingMessage) =>
      (req.headers['x-request-id'] as string) || randomUUID(),

    // Belt and braces. Even if a serializer below were changed to spread all
    // headers, these paths are scrubbed on the way out.
    redact: {
      paths: [
        'req.headers.cookie',
        'req.headers.authorization',
        'res.headers["set-cookie"]',
        'req.body',
        'password',
        '*.password',
      ],
      censor: '[redacted]',
    },

    serializers: {
      req(req: IncomingMessage & { id?: string; url?: string; method?: string; raw?: any }) {
        const raw = req.raw ?? req;
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          // req.ip is proxy-aware (see `trust proxy` in main.ts).
          ip: raw.ip ?? raw.socket?.remoteAddress,
          // Who did it, if they were signed in. The auth guard puts this on the
          // request. Never the token — just the identity it resolved to.
          userId: raw.user?.id,
          role: raw.user?.role,
          headers: pickSafeHeaders(raw.headers ?? {}),
        };
      },
      res(res: ServerResponse & { raw?: ServerResponse }) {
        const raw = (res.raw ?? res) as ServerResponse;
        return { statusCode: raw.statusCode };
      },
    },

    // The healthcheck fires every few seconds forever and says nothing.
    autoLogging: {
      ignore: (req: IncomingMessage) => req.url === '/api/health',
    },

    customLogLevel: (_req, res, err) => {
      if (err) return 'error';
      if (res.statusCode >= 500) return 'error';
      if (res.statusCode === 429) return 'warn'; // rate limit tripped — worth seeing
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  },
};
