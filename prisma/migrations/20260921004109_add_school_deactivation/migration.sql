-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalAction" ADD VALUE 'DEACTIVATE';
ALTER TYPE "ApprovalAction" ADD VALUE 'REACTIVATE';

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "deactivatedAt" TIMESTAMP(3),
ADD COLUMN     "deactivatedByAdminId" TEXT,
ADD COLUMN     "deactivationReason" TEXT;

-- CreateIndex
CREATE INDEX "School_deactivatedAt_idx" ON "School"("deactivatedAt");

-- AddForeignKey
ALTER TABLE "School" ADD CONSTRAINT "School_deactivatedByAdminId_fkey" FOREIGN KEY ("deactivatedByAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

