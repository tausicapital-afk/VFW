import {
  ArgumentsHost,
  Catch,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import * as Sentry from '@sentry/node';

/**
 * Error tracking.
 *
 * Sentry is optional: with no `SENTRY_DSN` set, `init()` does nothing and the
 * filter below degrades into plain Nest error handling. The app must never fail
 * to boot because an observability vendor is unconfigured.
 *
 * What is deliberately NOT sent:
 *
 *   - Cookies. `vfw_session` is a live JWT; shipping it to a third party would
 *     hand session-replay to anyone with Sentry access — a wider audience than
 *     the people allowed to sign in to an ERP.
 *   - Request bodies. That is where passwords are.
 *   - Authorization headers.
 *   - PII (`sendDefaultPii: false`). We attach a user *id* and role ourselves,
 *     which is what you need to reconstruct an incident. Not their email.
 *
 * Sentry's default integrations will happily attach all of the above, so the
 * scrubbing in `beforeSend` is not belt-and-braces — it is the whole belt.
 */
export function initSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    release: process.env.RAILWAY_GIT_COMMIT_SHA,

    // Never let the SDK decide that PII is fine to send.
    sendDefaultPii: false,

    // Money system, low traffic: sample everything. Revisit if volume grows.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),

    beforeSend(event) {
      const req = event.request;
      if (req) {
        // These three are the ways a secret escapes.
        delete req.cookies;
        delete req.data;
        if (req.headers) {
          delete req.headers.cookie;
          delete req.headers.Cookie;
          delete req.headers.authorization;
          delete req.headers.Authorization;
        }
        // A JWT can also ride in on a query string.
        if (typeof req.query_string === 'string') {
          req.query_string = req.query_string.replace(
            /([?&](?:token|jwt|session)=)[^&]+/gi,
            '$1[redacted]',
          );
        }
      }
      return event;
    },
  });

  return true;
}

/**
 * Reports unhandled faults to Sentry, then hands off to Nest's normal handling
 * so the client still gets its usual response shape.
 *
 * Only real faults are reported. A 400 from a validation pipe or a 403 from the
 * ACL guard is the system *working*, and paging on it would train everyone to
 * ignore Sentry. 429s likewise: the rate limiter doing its job is not an error.
 */
@Catch()
@Injectable()
export class SentryExceptionFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    if (this.shouldReport(exception)) {
      const req = host.switchToHttp().getRequest();
      Sentry.withScope((scope) => {
        if (req?.user) {
          // Identity, not PII: enough to ask "who hit this?", not enough to leak.
          scope.setUser({ id: req.user.id, role: req.user.role } as Sentry.User);
        }
        if (req?.id) scope.setTag('request_id', String(req.id));
        if (req?.method && req?.url) scope.setTransactionName(`${req.method} ${req.url}`);
        Sentry.captureException(exception);
      });
    }

    super.catch(exception, host);
  }

  private shouldReport(exception: unknown): boolean {
    if (!(exception instanceof HttpException)) return true; // crash, bug, DB down
    return exception.getStatus() >= HttpStatus.INTERNAL_SERVER_ERROR;
  }
}
