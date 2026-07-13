/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
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
