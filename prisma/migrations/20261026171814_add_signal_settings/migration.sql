-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'UPDATE_SIGNAL_SETTINGS';

-- CreateTable
CREATE TABLE "SchoolSignalSetting" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "absenceCount" INTEGER,
    "absenceWindowDays" INTEGER,
    "contentBehindPercent" INTEGER,
    "contentBehindMinPublished" INTEGER,
    "notSubmittedCount" INTEGER,
    "inactiveDays" INTEGER,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolSignalSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SchoolSignalSetting_schoolId_key" ON "SchoolSignalSetting"("schoolId");

-- AddForeignKey
ALTER TABLE "SchoolSignalSetting" ADD CONSTRAINT "SchoolSignalSetting_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
