-- Demo/test records seeded into the same database as the real book.
--
-- One flag, the same name and the same meaning, on every model that surfaces as
-- a row in a module table. It is orthogonal to every status those rows already
-- carry: a test submission is still PENDING or APPROVED, a test timesheet day is
-- still PRESENT. The flag says only where the row came from, so the console can
-- mark it and a reader can tell a rehearsal apart from a sale at a glance.
--
-- DEFAULT false, and no backfill in this migration, on purpose: the only thing
-- that may declare an existing row to be test data is somebody explicitly saying
-- so (Administration -> Test data, or `npm run testdata:mark`). A migration that
-- guessed would silently reclassify rows that money has moved against.
--
-- No index. Nothing filters on this column — the flag is rendered, not queried —
-- and an index on a boolean that is false for almost every row would earn
-- nothing but write cost. Add one alongside the first query that needs it.
ALTER TABLE "Submission" ADD COLUMN "isTestData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Contact" ADD COLUMN "isTestData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Payment" ADD COLUMN "isTestData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Event" ADD COLUMN "isTestData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Package" ADD COLUMN "isTestData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Addon" ADD COLUMN "isTestData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "EmailMessage" ADD COLUMN "isTestData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AttendanceEntry" ADD COLUMN "isTestData" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "PayrollInvoice" ADD COLUMN "isTestData" BOOLEAN NOT NULL DEFAULT false;
