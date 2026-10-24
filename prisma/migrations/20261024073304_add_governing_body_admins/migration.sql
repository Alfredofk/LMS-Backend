-- AlterTable
ALTER TABLE "GoverningBody" ADD COLUMN     "phone" TEXT;

-- AlterTable
ALTER TABLE "GoverningBodyAdmin" ADD COLUMN     "endReason" TEXT,
ADD COLUMN     "rejectionReason" TEXT;
