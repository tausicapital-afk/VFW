// Sentry has to be initialised before anything else is imported or constructed,
// so that its instrumentation is in place for the code it is meant to watch.
import { initSentry } from './common/sentry';
const sentryEnabled = initSentry();

import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Decimal } from '@prisma/client/runtime/library';
import cookieParser from 'cookie-parser';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { SentryExceptionFilter } from './common/sentry';

// Prisma returns Decimal for money columns, which JSON.stringify cannot encode.
// Serialize as a plain string rather than a number: the client must not be able
// to lose precision on a total by round-tripping it through a float.
(Decimal.prototype as any).toJSON = function (this: Decimal) {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });

  // Replace Nest's default logger with pino, so framework logs are structured
  // and carry the same request id as everything else.
  app.useLogger(app.get(Logger));

  /**
   * Trust the proxy chain in front of us, so `req.ip` is the caller's address
   * and not the address of whatever proxied to us. The rate limiter keys on
   * this: get it wrong and every request appears to come from one IP, which
   * would either throttle all users as if they were one attacker, or throttle
   * nobody.
   *
   * This is a HOP COUNT, not `true`. `trust proxy: true` takes the left-most
   * X-Forwarded-For entry, which is simply whatever the caller typed — an
   * attacker would rotate it per request and never be limited. A number makes
   * Express count that many hops in from the right, past the entries our own
   * infrastructure appended, which a caller cannot forge.
   *
   * In production the chain is: client -> Railway edge -> nginx (frontend
   * service) -> Railway edge -> this app. Confirm the real count against
   * GET /api/health/ip after any change to the proxy topology, and set
   * TRUST_PROXY_HOPS to match.
   */
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  app.set('trust proxy', hops > 0 ? hops : false);

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new SentryExceptionFilter(httpAdapter));

  // Credentials must be allowed for the session cookie to travel, which means
  // the origin has to be an explicit allowlist — "*" is rejected by browsers
  // the moment credentials are involved.
  //
  // Note this is now a fallback, not the main path: the frontend reverse-proxies
  // /api to this service, so the browser sees a single origin and never sends a
  // cross-origin request at all. See architecture.md §5.
  const origins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  const port = Number(process.env.PORT) || 3001;

  /**
   * Bind on `::`, not `0.0.0.0`.
   *
   * Railway's private network is IPv6-only. Once nginx proxies to
   * RAILWAY_PRIVATE_DOMAIN instead of the public domain (see architecture.md §5),
   * the only traffic this app ever sees arrives over IPv6 — and a socket bound to
   * 0.0.0.0 is listening on IPv4 only, so every request would be refused.
   *
   * `::` is dual-stack on Node (IPV6_V6ONLY off), so IPv4 callers — local dev,
   * the public domain while it still exists — keep working unchanged.
   */
  await app.listen(port, '::');

  app
    .get(Logger)
    .log(
      `VFW API listening on :${port} — CORS: ${origins.join(', ')} · trust proxy hops: ${hops} · Sentry: ${sentryEnabled ? 'on' : 'off (no SENTRY_DSN)'}`,
    );
}

bootstrap();
