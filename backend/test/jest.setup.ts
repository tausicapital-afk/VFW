import 'reflect-metadata';
import { testDatabaseUrl } from './test-db';

// Runs in every worker BEFORE the test file (and its AppModule import) loads, so
// PrismaClient is constructed against the test database, not the dev one.
process.env.DATABASE_URL = testDatabaseUrl();

// The JWT module needs a secret to sign session tokens; supply a throwaway one
// for tests if the environment has not.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-not-for-prod';
