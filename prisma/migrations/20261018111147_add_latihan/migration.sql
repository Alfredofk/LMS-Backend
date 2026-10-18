-- AlterEnum
ALTER TYPE "AssessmentType" ADD VALUE 'LATIHAN';

-- AlterTable
ALTER TABLE "Assessment" ALTER COLUMN "maxAttempts" DROP NOT NULL;
