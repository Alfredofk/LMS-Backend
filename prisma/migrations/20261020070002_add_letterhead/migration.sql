-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'UPDATE_LETTERHEAD';

-- AlterTable
ALTER TABLE "ReportCard" ADD COLUMN     "schoolAddress" TEXT,
ADD COLUMN     "schoolLogoKey" TEXT,
ADD COLUMN     "schoolPhone" TEXT;

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "address" TEXT,
ADD COLUMN     "logoStorageKey" TEXT,
ADD COLUMN     "phone" TEXT;
