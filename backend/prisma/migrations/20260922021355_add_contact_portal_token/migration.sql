-- AlterEnum
ALTER TYPE "EmailKind" ADD VALUE 'PORTAL_LINK';

-- CreateTable
CREATE TABLE "ContactPortalToken" (
    "token" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactPortalToken_pkey" PRIMARY KEY ("token")
);

-- CreateIndex
CREATE INDEX "ContactPortalToken_contactId_idx" ON "ContactPortalToken"("contactId");

-- AddForeignKey
ALTER TABLE "ContactPortalToken" ADD CONSTRAINT "ContactPortalToken_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
