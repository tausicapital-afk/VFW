-- Payroll moves from "which calendar month" to "which date range". Add the
-- new period columns nullable first so the backfill below can populate them
-- before they are made required.
ALTER TABLE "PayrollInvoice" ADD COLUMN "periodStart" DATE;
ALTER TABLE "PayrollInvoice" ADD COLUMN "periodEnd" DATE;

-- Every existing row's 'YYYY-MM' becomes the calendar range it always meant:
-- the 1st through the last day of that month.
UPDATE "PayrollInvoice"
SET "periodStart" = to_date("month" || '-01', 'YYYY-MM-DD'),
    "periodEnd" = (to_date("month" || '-01', 'YYYY-MM-DD') + INTERVAL '1 month - 1 day')::date;

-- Now that every row has a value, the columns can be required.
ALTER TABLE "PayrollInvoice" ALTER COLUMN "periodStart" SET NOT NULL;
ALTER TABLE "PayrollInvoice" ALTER COLUMN "periodEnd" SET NOT NULL;

-- DropIndex
DROP INDEX "PayrollInvoice_userId_month_key";

-- AlterTable
ALTER TABLE "PayrollInvoice" DROP COLUMN "month";

-- CreateIndex
CREATE UNIQUE INDEX "PayrollInvoice_userId_periodStart_periodEnd_key" ON "PayrollInvoice"("userId", "periodStart", "periodEnd");
