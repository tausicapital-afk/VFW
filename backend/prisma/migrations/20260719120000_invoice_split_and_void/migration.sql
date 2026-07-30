-- Invoicing is split by brand, and sales gain a reversible VOIDED state.
--
-- (1) Two invoice sequences. A Vancouver show bills under VFW (the existing
--     invoicePrefix / nextInvoiceSeq); every other city bills under GFC. The GFC
--     pair is added here with its own gapless sequence starting at 1001.
ALTER TABLE "Settings" ADD COLUMN "gfcInvoicePrefix" TEXT NOT NULL DEFAULT 'GFC-';
ALTER TABLE "Settings" ADD COLUMN "nextGfcInvoiceSeq" INTEGER NOT NULL DEFAULT 1001;

-- (2) VOIDED — a soft delete for Admin/Accounting. The row is hidden from normal
--     lists and reports but kept for audit and reversible; it never reuses its
--     ref or invoice number. Added as a new enum value (safe on PostgreSQL 12+;
--     not used within this migration's transaction).
ALTER TYPE "SubmissionStatus" ADD VALUE 'VOIDED';

-- (3) Void bookkeeping. `voidedFrom` records the status held just before the
--     void, so an unvoid restores it exactly; the who/when round out the trail.
ALTER TABLE "Submission" ADD COLUMN "voidedFrom" "SubmissionStatus";
ALTER TABLE "Submission" ADD COLUMN "voidedAt" TIMESTAMP(3);
ALTER TABLE "Submission" ADD COLUMN "voidedById" TEXT;

ALTER TABLE "Submission"
  ADD CONSTRAINT "Submission_voidedById_fkey"
  FOREIGN KEY ("voidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
