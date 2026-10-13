-- Add-ons get a tax of their own, picked apart from the package's. Existing
-- sales keep a null rate, which means their add-ons were taxed with the package.

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN "addonTaxCode" TEXT,
ADD COLUMN "addonTaxRate" DECIMAL(6,3),
ADD COLUMN "addonTaxAmount" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_addonTaxCode_fkey" FOREIGN KEY ("addonTaxCode") REFERENCES "TaxProfile"("code") ON DELETE SET NULL ON UPDATE CASCADE;
