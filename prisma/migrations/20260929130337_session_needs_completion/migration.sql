-- AlterEnum
ALTER TYPE "SessionCancelReason" ADD VALUE 'NOT_HELD';

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "needsCompletion" BOOLEAN NOT NULL DEFAULT false;
