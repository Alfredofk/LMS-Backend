-- CreateEnum
CREATE TYPE "SchoolTimeZone" AS ENUM ('WIB', 'WITA', 'WIT');

-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'UPDATE_TIME_ZONE';

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "timeZone" "SchoolTimeZone";

-- AlterTable
ALTER TABLE "SchoolRegistration" ADD COLUMN     "timeZone" "SchoolTimeZone";
