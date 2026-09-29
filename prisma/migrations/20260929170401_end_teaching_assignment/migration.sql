-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'END';

-- AlterEnum
ALTER TYPE "SessionCancelReason" ADD VALUE 'ASSIGNMENT_ENDED';

-- AlterTable
ALTER TABLE "ClassSubject" ADD COLUMN     "endReason" TEXT;
