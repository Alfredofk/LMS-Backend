-- CreateTable
CREATE TABLE "AssessmentException" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "opensAt" TIMESTAMP(3),
    "closesAt" TIMESTAMP(3),
    "extraAttempts" INTEGER NOT NULL DEFAULT 0,
    "setByUserId" TEXT NOT NULL,
    "removedAt" TIMESTAMP(3),
    "removedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssessmentException_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AssessmentException_schoolId_idx" ON "AssessmentException"("schoolId");

-- CreateIndex
CREATE INDEX "AssessmentException_assessmentId_idx" ON "AssessmentException"("assessmentId");

-- CreateIndex
CREATE INDEX "AssessmentException_studentProfileId_idx" ON "AssessmentException"("studentProfileId");

-- AddForeignKey
ALTER TABLE "AssessmentException" ADD CONSTRAINT "AssessmentException_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentException" ADD CONSTRAINT "AssessmentException_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssessmentException" ADD CONSTRAINT "AssessmentException_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Appended by hand (assessment ticket 05, from prisma/partial-indexes.sql): one live
-- exception per Student and Assessment, changed in place. A removed one must repeat,
-- so an exception taken back may be set again.
CREATE UNIQUE INDEX "AssessmentException_one_live_per_student"
    ON "AssessmentException" ("assessmentId", "studentProfileId")
    WHERE "removedAt" IS NULL;
