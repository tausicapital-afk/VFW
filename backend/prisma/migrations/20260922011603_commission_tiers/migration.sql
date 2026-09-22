-- AlterTable
ALTER TABLE "PayrollInvoice" ADD COLUMN     "tierBonus" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "CommissionTier" (
    "id" TEXT NOT NULL,
    "thresholdRevenue" DECIMAL(14,2) NOT NULL,
    "bonusPct" DECIMAL(5,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommissionTier_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommissionTier_thresholdRevenue_key" ON "CommissionTier"("thresholdRevenue");
