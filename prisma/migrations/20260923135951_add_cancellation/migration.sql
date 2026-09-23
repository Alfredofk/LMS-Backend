-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'CANCEL';

-- AlterEnum
ALTER TYPE "ApprovalStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
ALTER TYPE "MembershipStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "GuardianStudent" ADD COLUMN     "rejectionReason" TEXT;
