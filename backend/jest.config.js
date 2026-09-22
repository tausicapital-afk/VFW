/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // otplib pulls in @otplib/plugin-base32-scure -> @scure/base, and (via
  // @otplib/plugin-crypto-noble) @noble/hashes — all published as plain ESM
  // ("export const ...", no CJS build for the leaf files). Plain Node handles
  // this fine at runtime (verified: `node -e "require('otplib')"` resolves
  // and runs correctly via each package's own pre-bundled dist/*.cjs, which is
  // what backend/dist/main.js actually calls in production) because esbuild
  // inlined those ESM deps into each package's own CJS bundle at publish time.
  // Jest's resolver, though, does not consistently follow the same "exports"
  // path ts-jest's transform pipeline takes — it can land on a package's
  // TypeScript SOURCE tree instead of its bundled dist, which then imports the
  // ESM leaf files directly and fails to parse ("Unexpected token 'export'")
  // under Jest's default node_modules-is-untransformed rule. Letting ts-jest
  // also transform (not just type-check) this small dependency cluster fixes
  // parsing wherever the resolver lands, without touching runtime behaviour —
  // confirmed by running every spec that imports the auth module chain with
  // zero remaining "Unexpected token"/"SyntaxError" output.
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {}],
    '^.+\\.jsx?$': ['ts-jest', { isolatedModules: true }],
  },
  transformIgnorePatterns: ['/node_modules/(?!(@scure|@otplib|@noble|otplib)/)'],
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
