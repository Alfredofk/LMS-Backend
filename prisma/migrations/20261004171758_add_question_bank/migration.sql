-- CreateEnum
CREATE TYPE "QuestionKind" AS ENUM ('MCQ', 'TF', 'SHORT', 'ESSAY');

-- CreateEnum
CREATE TYPE "McqScoring" AS ENUM ('SINGLE', 'ALL_OR_NOTHING', 'PARTIAL');

-- CreateTable
CREATE TABLE "Question" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "gradeLevel" INTEGER NOT NULL,
    "kind" "QuestionKind" NOT NULL,
    "mcqScoring" "McqScoring",
    "payload" JSONB NOT NULL,
    "answerKey" JSONB,
    "authorMembershipId" TEXT NOT NULL,
    "duplicatedFromId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionImage" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "uploadedByMembershipId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Question_schoolId_subjectId_gradeLevel_idx" ON "Question"("schoolId", "subjectId", "gradeLevel");

-- CreateIndex
CREATE INDEX "Question_authorMembershipId_idx" ON "Question"("authorMembershipId");

-- CreateIndex
CREATE INDEX "QuestionImage_schoolId_idx" ON "QuestionImage"("schoolId");

-- CreateIndex
CREATE INDEX "QuestionImage_uploadedByMembershipId_idx" ON "QuestionImage"("uploadedByMembershipId");

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_authorMembershipId_fkey" FOREIGN KEY ("authorMembershipId") REFERENCES "SchoolMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_duplicatedFromId_fkey" FOREIGN KEY ("duplicatedFromId") REFERENCES "Question"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionImage" ADD CONSTRAINT "QuestionImage_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionImage" ADD CONSTRAINT "QuestionImage_uploadedByMembershipId_fkey" FOREIGN KEY ("uploadedByMembershipId") REFERENCES "SchoolMembership"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
