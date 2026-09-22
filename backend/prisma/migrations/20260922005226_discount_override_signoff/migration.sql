-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "discountOverrideRequestedAt" TIMESTAMP(3),
ADD COLUMN     "discountOverrideRequestedById" TEXT;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_discountOverrideRequestedById_fkey" FOREIGN KEY ("discountOverrideRequestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
