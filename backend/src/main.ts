import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Decimal } from '@prisma/client/runtime/library';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

// Prisma returns Decimal for money columns, which JSON.stringify cannot encode.
// Serialize as a plain string rather than a number: the client must not be able
// to lose precision on a total by round-tripping it through a float.
(Decimal.prototype as any).toJSON = function (this: Decimal) {
  return this.toString();
};

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.use(cookieParser());

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Credentials must be allowed for the session cookie to travel, which means
  // the origin has to be an explicit allowlist — "*" is rejected by browsers
  // the moment credentials are involved.
  const origins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({ origin: origins, credentials: true });

  const port = Number(process.env.PORT) || 3001;
  await app.listen(port, '0.0.0.0');
  console.log(`VFW API listening on :${port} (CORS: ${origins.join(', ')})`);
}

bootstrap();
