/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // otplib's package.json "exports" map correctly resolves `require('otplib')`
  // to its pre-bundled dist/index.cjs under plain Node (verified: `node -e
  // "require.resolve('otplib')"` returns the .cjs file, and requiring it works
  // fine) — this is what backend/dist/main.js actually calls at runtime.
  // ts-jest's resolver does not follow that "exports" map the same way and
  // falls through to otplib's TypeScript SOURCE tree instead, which imports
  // its ESM-only @otplib/plugin-base32-scure -> @scure/base dependency and
  // fails to parse ("Unexpected token 'export'") under Jest's CJS transform.
  // Forcing the same resolution Node already uses sidesteps the resolver gap
  // without touching runtime behaviour.
  moduleNameMapper: {
    '^otplib$': '<rootDir>/node_modules/otplib/dist/index.cjs',
  },
  testRegex: '\\.spec\\.ts$',
  // Sync + seed the throwaway test database once before the whole suite.
  globalSetup: '<rootDir>/test/global-setup.ts',
  // Point PrismaClient at the test DB and supply a JWT secret, before any
  // AppModule import in a worker. Also loads reflect-metadata for decorators.
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
  // Integration specs boot the Nest app and hit Postgres; give them room.
  testTimeout: 30000,
  // Run serially: each integration spec opens a Nest app with its own Prisma
  // connection pool, and parallel workers can otherwise exhaust Postgres
  // connections. The suite is fast enough that serial is the right trade.
  maxWorkers: 1,
};
