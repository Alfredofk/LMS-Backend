-- CreateEnum
CREATE TYPE "SubmissionClose" AS ENUM ('STUDENT', 'TIME');

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "assessmentId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "closedBy" "SubmissionClose",
    "late" BOOLEAN NOT NULL DEFAULT false,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "shownOrder" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionAnswer" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "assessmentQuestionId" TEXT NOT NULL,
    "value" BOOLEAN,
    "text" TEXT,
    "fileStorageKey" TEXT,
    "fileName" TEXT,
    "fileMimeType" TEXT,
    "fileSize" INTEGER,
    "autoPoints" DECIMAL(7,4),
    "savedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubmissionAnswer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SubmissionAnswerOption" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "answerId" TEXT NOT NULL,
    "assessmentQuestionId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,

    CONSTRAINT "SubmissionAnswerOption_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Submission_schoolId_idx" ON "Submission"("schoolId");

-- CreateIndex
CREATE INDEX "Submission_studentProfileId_idx" ON "Submission"("studentProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "Submission_assessmentId_studentProfileId_attempt_key" ON "Submission"("assessmentId", "studentProfileId", "attempt");

-- CreateIndex
CREATE INDEX "SubmissionAnswer_schoolId_idx" ON "SubmissionAnswer"("schoolId");

-- CreateIndex
CREATE INDEX "SubmissionAnswer_assessmentQuestionId_idx" ON "SubmissionAnswer"("assessmentQuestionId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionAnswer_submissionId_assessmentQuestionId_key" ON "SubmissionAnswer"("submissionId", "assessmentQuestionId");

-- CreateIndex
CREATE INDEX "SubmissionAnswerOption_assessmentQuestionId_optionId_idx" ON "SubmissionAnswerOption"("assessmentQuestionId", "optionId");

-- CreateIndex
CREATE INDEX "SubmissionAnswerOption_schoolId_idx" ON "SubmissionAnswerOption"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "SubmissionAnswerOption_answerId_optionId_key" ON "SubmissionAnswerOption"("answerId", "optionId");

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_assessmentId_fkey" FOREIGN KEY ("assessmentId") REFERENCES "Assessment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAnswer" ADD CONSTRAINT "SubmissionAnswer_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAnswer" ADD CONSTRAINT "SubmissionAnswer_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAnswer" ADD CONSTRAINT "SubmissionAnswer_assessmentQuestionId_fkey" FOREIGN KEY ("assessmentQuestionId") REFERENCES "AssessmentQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAnswerOption" ADD CONSTRAINT "SubmissionAnswerOption_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAnswerOption" ADD CONSTRAINT "SubmissionAnswerOption_answerId_fkey" FOREIGN KEY ("answerId") REFERENCES "SubmissionAnswer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SubmissionAnswerOption" ADD CONSTRAINT "SubmissionAnswerOption_assessmentQuestionId_fkey" FOREIGN KEY ("assessmentQuestionId") REFERENCES "AssessmentQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Appended by hand (assessment ticket 03, from prisma/partial-indexes.sql): one
-- Submission in progress per Student and Assessment. Handed-in and void ones must
-- repeat - max attempts allows several, and a void one is kept beside the next.
CREATE UNIQUE INDEX "Submission_one_in_progress_per_student"
    ON "Submission" ("assessmentId", "studentProfileId")
    WHERE "submittedAt" IS NULL AND "voidedAt" IS NULL;
