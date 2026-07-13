import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Decimal } from '@prisma/client/runtime/library';
import cookieParser from 'cookie-parser';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { SESSION_COOKIE } from '../src/common/cookie';

// Mirror main.ts: Decimal must serialise as a string, or a total loses precision
// on the way to the client — and the ACL/DTO tests assert on that shape.
(Decimal.prototype as unknown as { toJSON: () => string }).toJSON = function (this: Decimal) {
  return this.toString();
};

/**
 * Boot the real application graph the same way main.ts does — global validation
 * pipe (whitelist + forbidNonWhitelisted), cookie parser, and the global auth
 * guard that AppModule registers. Integration tests exercise the true request
 * path, not a mock of it.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
  return app;
}

export function http(app: INestApplication) {
  return request(app.getHttpServer() as Server);
}

/** Sign in and return the raw session cookie string to replay on later calls. */
export async function loginCookie(app: INestApplication, email: string, password = 'Vfw@2026!') {
  const res = await http(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  const cookie = (setCookie ?? []).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) throw new Error(`no session cookie returned for ${email}`);
  return cookie.split(';')[0];
}
