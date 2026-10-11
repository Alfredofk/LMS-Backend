-- AlterTable
ALTER TABLE "AssessmentException" ADD COLUMN     "remedial" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "remedial" BOOLEAN NOT NULL DEFAULT false;
