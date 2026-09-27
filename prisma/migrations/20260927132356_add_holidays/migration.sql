-- CreateEnum
CREATE TYPE "HolidayKind" AS ENUM ('NATIONAL', 'JOINT_LEAVE');

-- CreateEnum
CREATE TYPE "HolidayStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'WITHDRAWN');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalAction" ADD VALUE 'WITHDRAW';
ALTER TYPE "ApprovalAction" ADD VALUE 'UPDATE_JOINT_LEAVE';

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "observesJointLeave" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "NationalHoliday" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "HolidayKind" NOT NULL,
    "status" "HolidayStatus" NOT NULL DEFAULT 'DRAFT',
    "source" TEXT NOT NULL,
    "confirmedByAdminId" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "withdrawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NationalHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolHoliday" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NationalHoliday_status_date_idx" ON "NationalHoliday"("status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "NationalHoliday_date_name_key" ON "NationalHoliday"("date", "name");

-- CreateIndex
CREATE INDEX "SchoolHoliday_schoolId_startDate_idx" ON "SchoolHoliday"("schoolId", "startDate");

-- AddForeignKey
ALTER TABLE "NationalHoliday" ADD CONSTRAINT "NationalHoliday_confirmedByAdminId_fkey" FOREIGN KEY ("confirmedByAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolHoliday" ADD CONSTRAINT "SchoolHoliday_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
