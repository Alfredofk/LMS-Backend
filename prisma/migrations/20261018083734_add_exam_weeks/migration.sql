-- CreateEnum
CREATE TYPE "ExamWeekType" AS ENUM ('UTS', 'UAS');

-- AlterEnum
ALTER TYPE "SessionCancelReason" ADD VALUE 'EXAM_WEEK';

-- CreateTable
CREATE TABLE "ExamWeek" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "semesterId" TEXT NOT NULL,
    "type" "ExamWeekType" NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "gradeLevels" INTEGER[],
    "createdByUserId" TEXT NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExamWeek_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExamWeek_schoolId_startDate_idx" ON "ExamWeek"("schoolId", "startDate");

-- CreateIndex
CREATE INDEX "ExamWeek_semesterId_idx" ON "ExamWeek"("semesterId");

-- AddForeignKey
ALTER TABLE "ExamWeek" ADD CONSTRAINT "ExamWeek_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamWeek" ADD CONSTRAINT "ExamWeek_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester"("id") ON DELETE CASCADE ON UPDATE CASCADE;
