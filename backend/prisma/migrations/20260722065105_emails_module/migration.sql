-- CreateEnum
CREATE TYPE "EmailDirection" AS ENUM ('OUTBOUND', 'INBOUND');

-- CreateEnum
CREATE TYPE "EmailStatus" AS ENUM ('SENT', 'FAILED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "EmailKind" AS ENUM ('OTP', 'WELCOME', 'PASSWORD_RESET', 'PASSWORD_CHANGED', 'INVITATION', 'INVOICE', 'TEST', 'INBOUND', 'OTHER');

-- AlterTable
ALTER TABLE "MailAccount" ADD COLUMN     "imapHost" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "imapPort" INTEGER NOT NULL DEFAULT 993,
ADD COLUMN     "inboundEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "EmailMessage" (
    "id" TEXT NOT NULL,
    "direction" "EmailDirection" NOT NULL,
    "status" "EmailStatus" NOT NULL,
    "kind" "EmailKind" NOT NULL DEFAULT 'OTHER',
    "fromAddress" TEXT NOT NULL,
    "fromName" TEXT,
    "toAddress" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT,
    "bodyHtml" TEXT,
    "preview" TEXT,
    "provider" TEXT,
    "mailAccountId" TEXT,
    "error" TEXT,
    "triggeredById" TEXT,
    "submissionId" TEXT,
    "messageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EmailMessage_direction_createdAt_idx" ON "EmailMessage"("direction", "createdAt");

-- CreateIndex
CREATE INDEX "EmailMessage_triggeredById_idx" ON "EmailMessage"("triggeredById");

-- CreateIndex
CREATE INDEX "EmailMessage_submissionId_idx" ON "EmailMessage"("submissionId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailMessage_mailAccountId_messageId_key" ON "EmailMessage"("mailAccountId", "messageId");

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailMessage" ADD CONSTRAINT "EmailMessage_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
