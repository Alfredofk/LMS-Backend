-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'UPDATE_SUBJECTS';

-- CreateTable
CREATE TABLE "SchoolSubjectChoice" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "selected" BOOLEAN NOT NULL,
    "decidedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolSubjectChoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SchoolSubjectChoice_schoolId_subjectId_key" ON "SchoolSubjectChoice"("schoolId", "subjectId");

-- AddForeignKey
ALTER TABLE "SchoolSubjectChoice" ADD CONSTRAINT "SchoolSubjectChoice_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolSubjectChoice" ADD CONSTRAINT "SchoolSubjectChoice_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
