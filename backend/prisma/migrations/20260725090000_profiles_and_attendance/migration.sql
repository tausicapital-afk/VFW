-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'REMOTE', 'LEAVE', 'SICK', 'HOLIDAY', 'ABSENT');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "avatarKey" TEXT,
ADD COLUMN     "title" TEXT;

-- CreateTable
CREATE TABLE "AttendanceEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "status" "AttendanceStatus" NOT NULL DEFAULT 'PRESENT',
    "hours" DECIMAL(4,2) NOT NULL DEFAULT 0,
    "checkIn" TEXT,
    "checkOut" TEXT,
    "note" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AttendanceEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttendanceEntry_date_idx" ON "AttendanceEntry"("date");

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceEntry_userId_date_key" ON "AttendanceEntry"("userId", "date");

-- AddForeignKey
ALTER TABLE "AttendanceEntry" ADD CONSTRAINT "AttendanceEntry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceEntry" ADD CONSTRAINT "AttendanceEntry_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
