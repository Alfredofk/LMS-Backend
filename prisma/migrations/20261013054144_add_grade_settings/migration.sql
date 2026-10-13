-- CreateEnum
CREATE TYPE "RemedialRule" AS ENUM ('CAP_AT_KKTP', 'HIGHEST', 'AVERAGE');

-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'UPDATE_GRADE_SETTINGS';

-- CreateTable
CREATE TABLE "SchoolGradeSetting" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "weightTugas" INTEGER,
    "weightKuis" INTEGER,
    "weightUts" INTEGER,
    "weightUas" INTEGER,
    "kktp" INTEGER,
    "remedialRule" "RemedialRule",
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolGradeSetting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SlotGradeSetting" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "semesterId" TEXT NOT NULL,
    "weightTugas" INTEGER,
    "weightKuis" INTEGER,
    "weightUts" INTEGER,
    "weightUas" INTEGER,
    "kktp" INTEGER,
    "setByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlotGradeSetting_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SchoolGradeSetting_schoolId_key" ON "SchoolGradeSetting"("schoolId");

-- CreateIndex
CREATE INDEX "SlotGradeSetting_schoolId_idx" ON "SlotGradeSetting"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "SlotGradeSetting_classId_subjectId_semesterId_key" ON "SlotGradeSetting"("classId", "subjectId", "semesterId");

-- AddForeignKey
ALTER TABLE "SchoolGradeSetting" ADD CONSTRAINT "SchoolGradeSetting_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotGradeSetting" ADD CONSTRAINT "SlotGradeSetting_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotGradeSetting" ADD CONSTRAINT "SlotGradeSetting_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotGradeSetting" ADD CONSTRAINT "SlotGradeSetting_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotGradeSetting" ADD CONSTRAINT "SlotGradeSetting_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester"("id") ON DELETE CASCADE ON UPDATE CASCADE;
