-- CreateEnum
CREATE TYPE "PayrollInvoiceStatus" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED');

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "packageBlurbOverride" TEXT,
ADD COLUMN     "packageCustomized" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "packageLooksOverride" INTEGER,
ADD COLUMN     "packageNameOverride" TEXT,
ADD COLUMN     "packagePriceOverride" DECIMAL(14,2);

-- CreateTable
CREATE TABLE "PayrollInvoice" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" "PayrollInvoiceStatus" NOT NULL DEFAULT 'SUBMITTED',
    "payType" "PayType" NOT NULL,
    "baseRate" DECIMAL(14,2) NOT NULL,
    "hours" DECIMAL(6,2) NOT NULL,
    "base" DECIMAL(14,2) NOT NULL,
    "commissionPct" DECIMAL(5,2) NOT NULL,
    "commission" DECIMAL(14,2) NOT NULL,
    "gross" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PayrollInvoice_status_idx" ON "PayrollInvoice"("status");

-- CreateIndex
CREATE INDEX "PayrollInvoice_userId_idx" ON "PayrollInvoice"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollInvoice_userId_month_key" ON "PayrollInvoice"("userId", "month");

-- AddForeignKey
ALTER TABLE "PayrollInvoice" ADD CONSTRAINT "PayrollInvoice_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollInvoice" ADD CONSTRAINT "PayrollInvoice_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
