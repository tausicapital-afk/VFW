-- CreateEnum
CREATE TYPE "PayType" AS ENUM ('SALARY', 'HOURLY', 'COMMISSION_ONLY');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "baseRate" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "payType" "PayType" NOT NULL DEFAULT 'COMMISSION_ONLY';

-- CreateIndex
CREATE UNIQUE INDEX "Submission_invoiceNo_key" ON "Submission"("invoiceNo");
