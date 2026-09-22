-- Online payment collection (Stripe): maps a Stripe Checkout Session back to
-- the submission it was created for, and gives the webhook something to claim
-- atomically so a retried delivery can never post the same payment twice. See
-- prisma/schema.prisma for the full reasoning.

-- CreateEnum
CREATE TYPE "StripeCheckoutSessionStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateTable
CREATE TABLE "StripeCheckoutSession" (
    "id" TEXT NOT NULL,
    "stripeSessionId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "status" "StripeCheckoutSessionStatus" NOT NULL DEFAULT 'PENDING',
    "paymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StripeCheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StripeCheckoutSession_stripeSessionId_key" ON "StripeCheckoutSession"("stripeSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "StripeCheckoutSession_paymentId_key" ON "StripeCheckoutSession"("paymentId");

-- CreateIndex
CREATE INDEX "StripeCheckoutSession_submissionId_idx" ON "StripeCheckoutSession"("submissionId");

-- AddForeignKey
ALTER TABLE "StripeCheckoutSession" ADD CONSTRAINT "StripeCheckoutSession_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StripeCheckoutSession" ADD CONSTRAINT "StripeCheckoutSession_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
