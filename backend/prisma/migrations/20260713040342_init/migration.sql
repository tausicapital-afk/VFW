-- CreateEnum
CREATE TYPE "Role" AS ENUM ('SALES', 'INTERN', 'ACCT', 'MGR', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('USD', 'CAD', 'GBP', 'EUR', 'JPY');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('DRAFT', 'PENDING', 'RETURNED', 'APPROVED', 'REJECTED', 'EXPORTED');

-- CreateEnum
CREATE TYPE "PayStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PCT', 'AMT');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "employeeId" TEXT,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "department" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "commissionPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "target" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "colour" TEXT NOT NULL DEFAULT '#0E0E11',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "department" TEXT,
    "email" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT NOT NULL,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LoginAttempt" (
    "email" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "lockUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LoginAttempt_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "PasswordReset" (
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordReset_pkey" PRIMARY KEY ("token")
);

-- CreateTable
CREATE TABLE "TaxProfile" (
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "rate" DECIMAL(6,3) NOT NULL,
    "gst" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "pst" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "hst" DECIMAL(6,3) NOT NULL DEFAULT 0,
    "note" TEXT,

    CONSTRAINT "TaxProfile_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "City" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "taxCode" TEXT NOT NULL,

    CONSTRAINT "City_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "venue" TEXT,
    "start" DATE NOT NULL,
    "end" DATE NOT NULL,
    "cityId" TEXT NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GlAccount" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "GlAccount_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Package" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "looks" INTEGER NOT NULL,
    "blurb" TEXT,
    "listValue" DECIMAL(14,2),
    "cap" INTEGER,
    "taxCode" TEXT NOT NULL,
    "glCode" TEXT NOT NULL,

    CONSTRAINT "Package_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PackagePrice" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "PackagePrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Addon" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" DECIMAL(14,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "note" TEXT,
    "forBrands" TEXT[],
    "glCode" TEXT NOT NULL,

    CONSTRAINT "Addon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "designer" TEXT NOT NULL,
    "company" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "country" TEXT,
    "type" TEXT NOT NULL DEFAULT 'Designer',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "status" "SubmissionStatus" NOT NULL DEFAULT 'DRAFT',
    "repId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "cityId" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "showDate" DATE,
    "notes" TEXT,
    "currency" "Currency" NOT NULL,
    "packagePrice" DECIMAL(14,2) NOT NULL,
    "addonTotal" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discountType" "DiscountType" NOT NULL DEFAULT 'PCT',
    "discountValue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "discountAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "taxable" DECIMAL(14,2) NOT NULL,
    "taxRate" DECIMAL(6,3) NOT NULL,
    "taxAmount" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "deposit" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balance" DECIMAL(14,2) NOT NULL,
    "payStatus" "PayStatus" NOT NULL DEFAULT 'UNPAID',
    "commissionPct" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "commissionAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "paymentMethod" TEXT,
    "paymentTerms" TEXT,
    "taxCode" TEXT NOT NULL,
    "glCode" TEXT,
    "costCentre" TEXT,
    "department" TEXT,
    "submittedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedById" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectReason" TEXT,
    "returnNote" TEXT,
    "exportedAt" TIMESTAMP(3),
    "qbDocNumber" TEXT,
    "invoiceNo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionAddon" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "addonId" TEXT NOT NULL,
    "qty" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(14,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "SubmissionAddon_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" "Currency" NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT,
    "size" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uploadedById" TEXT NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InternalComment" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "department" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "authorId" TEXT NOT NULL,

    CONSTRAINT "InternalComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignerFeedback" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "body" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedById" TEXT NOT NULL,

    CONSTRAINT "DesignerFeedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEntry" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT,
    "action" TEXT NOT NULL,
    "detail" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,

    CONSTRAINT "AuditEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "company" TEXT NOT NULL DEFAULT 'VFW Management Inc.',
    "fiscalYear" INTEGER NOT NULL DEFAULT 2026,
    "invoicePrefix" TEXT NOT NULL DEFAULT 'VFW-',
    "nextInvoiceSeq" INTEGER NOT NULL DEFAULT 2041,
    "discountApprovalPct" DECIMAL(5,2) NOT NULL DEFAULT 15,
    "qbRealmId" TEXT,
    "fxRates" JSONB NOT NULL DEFAULT '{"CAD":1,"USD":1.37,"GBP":1.74,"EUR":1.49,"JPY":0.0092}',
    "scoreWeights" JSONB NOT NULL DEFAULT '{"revenue":30,"approved":20,"collection":30,"retention":20}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_employeeId_key" ON "User"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_role_status_idx" ON "User"("role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_code_key" ON "Invitation"("code");

-- CreateIndex
CREATE INDEX "Invitation_code_idx" ON "Invitation"("code");

-- CreateIndex
CREATE INDEX "Event_brand_idx" ON "Event"("brand");

-- CreateIndex
CREATE INDEX "Package_brand_idx" ON "Package"("brand");

-- CreateIndex
CREATE UNIQUE INDEX "PackagePrice_packageId_cityId_key" ON "PackagePrice"("packageId", "cityId");

-- CreateIndex
CREATE INDEX "Addon_brand_idx" ON "Addon"("brand");

-- CreateIndex
CREATE INDEX "Contact_designer_idx" ON "Contact"("designer");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_brand_key" ON "Contact"("brand");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_ref_key" ON "Submission"("ref");

-- CreateIndex
CREATE INDEX "Submission_status_idx" ON "Submission"("status");

-- CreateIndex
CREATE INDEX "Submission_repId_status_idx" ON "Submission"("repId", "status");

-- CreateIndex
CREATE INDEX "Submission_eventId_idx" ON "Submission"("eventId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionAddon_submissionId_addonId_key" ON "SubmissionAddon"("submissionId", "addonId");

-- CreateIndex
CREATE INDEX "Payment_submissionId_idx" ON "Payment"("submissionId");

-- CreateIndex
CREATE INDEX "Document_submissionId_idx" ON "Document"("submissionId");

-- CreateIndex
CREATE INDEX "InternalComment_submissionId_idx" ON "InternalComment"("submissionId");

-- CreateIndex
CREATE INDEX "DesignerFeedback_contactId_idx" ON "DesignerFeedback"("contactId");

-- CreateIndex
CREATE INDEX "AuditEntry_submissionId_createdAt_idx" ON "AuditEntry"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEntry_createdAt_idx" ON "AuditEntry"("createdAt");

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PasswordReset" ADD CONSTRAINT "PasswordReset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "City" ADD CONSTRAINT "City_taxCode_fkey" FOREIGN KEY ("taxCode") REFERENCES "TaxProfile"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_taxCode_fkey" FOREIGN KEY ("taxCode") REFERENCES "TaxProfile"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Package" ADD CONSTRAINT "Package_glCode_fkey" FOREIGN KEY ("glCode") REFERENCES "GlAccount"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackagePrice" ADD CONSTRAINT "PackagePrice_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PackagePrice" ADD CONSTRAINT "PackagePrice_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Addon" ADD CONSTRAINT "Addon_glCode_fkey" FOREIGN KEY ("glCode") REFERENCES "GlAccount"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_repId_fkey" FOREIGN KEY ("repId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "City"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "Package"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_taxCode_fkey" FOREIGN KEY ("taxCode") REFERENCES "TaxProfile"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_glCode_fkey" FOREIGN KEY ("glCode") REFERENCES "GlAccount"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAddon" ADD CONSTRAINT "SubmissionAddon_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAddon" ADD CONSTRAINT "SubmissionAddon_addonId_fkey" FOREIGN KEY ("addonId") REFERENCES "Addon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_uploadedById_fkey" FOREIGN KEY ("uploadedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalComment" ADD CONSTRAINT "InternalComment_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InternalComment" ADD CONSTRAINT "InternalComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignerFeedback" ADD CONSTRAINT "DesignerFeedback_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignerFeedback" ADD CONSTRAINT "DesignerFeedback_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEntry" ADD CONSTRAINT "AuditEntry_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEntry" ADD CONSTRAINT "AuditEntry_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
