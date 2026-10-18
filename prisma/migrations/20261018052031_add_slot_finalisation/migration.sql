-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalAction" ADD VALUE 'START_FINALIZING';
ALTER TYPE "ApprovalAction" ADD VALUE 'STOP_FINALIZING';

-- AlterTable
ALTER TABLE "SlotDescription" ALTER COLUMN "text" DROP NOT NULL;

-- CreateTable
CREATE TABLE "SlotFinalisation" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "semesterId" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "finalisedByUserId" TEXT NOT NULL,
    "finalisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneByUserId" TEXT,
    "undoneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlotFinalisation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlotFinalisation_schoolId_idx" ON "SlotFinalisation"("schoolId");

-- CreateIndex
CREATE INDEX "SlotFinalisation_semesterId_idx" ON "SlotFinalisation"("semesterId");

-- AddForeignKey
ALTER TABLE "SlotFinalisation" ADD CONSTRAINT "SlotFinalisation_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotFinalisation" ADD CONSTRAINT "SlotFinalisation_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotFinalisation" ADD CONSTRAINT "SlotFinalisation_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotFinalisation" ADD CONSTRAINT "SlotFinalisation_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One live finalisation per slot (grading-and-report-card 04): Class x Subject x
-- Semester. An undone one must repeat, so a slot unfinalised may be finalised again.
-- Appended by hand from prisma/partial-indexes.sql.
CREATE UNIQUE INDEX "SlotFinalisation_one_live_per_slot"
    ON "SlotFinalisation" ("classId", "subjectId", "semesterId")
    WHERE "undoneAt" IS NULL;
