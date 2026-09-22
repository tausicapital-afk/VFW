-- AlterTable
ALTER TABLE "User" ADD COLUMN     "googleId" TEXT,
ADD COLUMN     "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "totpSecret" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
