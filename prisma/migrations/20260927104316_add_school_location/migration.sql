-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'UPDATE_LOCATION';

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "SchoolRegistration" ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "longitude" DOUBLE PRECISION;
