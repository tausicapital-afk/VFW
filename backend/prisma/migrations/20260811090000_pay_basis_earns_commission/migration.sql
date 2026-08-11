-- Pay basis: whether a person earns commission, alongside how their base is paid.
--
-- `payType` already says how base pay is worked out (salary, hourly, or none at
-- all for a commission-only rep). It could not say the other half — that someone
-- is on a salary and NOT on commission — because commission was simply added on
-- top of every pay type. Every salaried account was therefore implicitly on
-- both, whether or not that was the arrangement they were hired on.
--
-- This column is that missing half. Crossed with `payType` it gives the three
-- arrangements an administrator actually needs to record:
--
--   commission only   COMMISSION_ONLY + true
--   salary only       SALARY / HOURLY + false
--   both              SALARY / HOURLY + true
--
-- DEFAULT true, and no backfill: true is exactly what every existing account was
-- already being paid on, so this migration changes nobody's pay. Whoever should
-- be salary-only is switched deliberately from Administration -> Users, and the
-- switch moves their NEXT sale — a submission carries the commission rate it was
-- stamped with, and nothing here rewrites one already on the books.
ALTER TABLE "User" ADD COLUMN "earnsCommission" BOOLEAN NOT NULL DEFAULT true;

-- The same flag frozen onto a submitted payroll invoice, beside the rate it was
-- snapshotted with. An invoice showing 8.00% and $0.00 commission is ambiguous
-- forever without it: a rep who closed nothing, or somebody not on commission?
-- Existing invoices were all raised under the old always-on behaviour, so true
-- is the historically accurate value for every one of them.
ALTER TABLE "PayrollInvoice" ADD COLUMN "earnsCommission" BOOLEAN NOT NULL DEFAULT true;
