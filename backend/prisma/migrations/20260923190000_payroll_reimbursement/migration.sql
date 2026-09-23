-- AlterTable
ALTER TABLE "PayrollInvoice" ADD COLUMN     "reimbursement" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "PayrollReimbursement" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodStart" DATE NOT NULL,
    "periodEnd" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollReimbursement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PayrollReimbursement_userId_periodStart_periodEnd_key" ON "PayrollReimbursement"("userId", "periodStart", "periodEnd");

-- AddForeignKey
ALTER TABLE "PayrollReimbursement" ADD CONSTRAINT "PayrollReimbursement_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
