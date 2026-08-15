-- QuickBooks Online integration: the OAuth connection (one company at a time,
-- same singleton convention as Settings) and the local-code -> QBO-object-id
-- mapping table. See prisma/schema.prisma for the reasoning on each field.

-- CreateEnum
CREATE TYPE "QboMappingKind" AS ENUM ('TAX', 'GL', 'DEPARTMENT');

-- CreateTable
CREATE TABLE "QboConnection" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "environment" TEXT NOT NULL,
    "realmId" TEXT NOT NULL,
    "companyName" TEXT,
    "accessToken" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "refreshTokenExpiresAt" TIMESTAMP(3) NOT NULL,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "connectedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QboConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QboMapping" (
    "id" TEXT NOT NULL,
    "kind" "QboMappingKind" NOT NULL,
    "localCode" TEXT NOT NULL,
    "qboId" TEXT NOT NULL,
    "qboLabel" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "QboMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QboMapping_kind_localCode_key" ON "QboMapping"("kind", "localCode");

-- AddForeignKey
ALTER TABLE "QboConnection" ADD CONSTRAINT "QboConnection_connectedById_fkey" FOREIGN KEY ("connectedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QboMapping" ADD CONSTRAINT "QboMapping_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: the real QuickBooks object id once posted, and the last live
-- push's failure message (export does not move APPROVED -> EXPORTED on
-- failure, so this is what tells accounting why it's still sitting there).
ALTER TABLE "Submission" ADD COLUMN "qboInvoiceId" TEXT;
ALTER TABLE "Submission" ADD COLUMN "qboSyncError" TEXT;

-- Settings.qbRealmId was a hand-typed placeholder from before this connection
-- existed. QboConnection.realmId replaces it, populated by the OAuth callback.
ALTER TABLE "Settings" DROP COLUMN "qbRealmId";
