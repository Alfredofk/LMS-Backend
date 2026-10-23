-- CreateEnum
CREATE TYPE "GoverningBodyKind" AS ENUM ('FOUNDATION', 'ASSOCIATION', 'GOVERNMENT');

-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'UPDATE_GOVERNING_BODY';

-- AlterTable
ALTER TABLE "HandoffCode" ADD COLUMN     "governingBodyId" TEXT,
ALTER COLUMN "schoolId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "governingBodyId" TEXT;

-- AlterTable
ALTER TABLE "School" ADD COLUMN     "governingBodyId" TEXT;

-- CreateTable
CREATE TABLE "GoverningBodyRegistration" (
    "id" TEXT NOT NULL,
    "applicantUserId" TEXT NOT NULL,
    "kind" "GoverningBodyKind" NOT NULL,
    "name" TEXT NOT NULL,
    "skNumber" TEXT,
    "street" TEXT NOT NULL,
    "village" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "postalCode" TEXT,
    "applicantPhone" TEXT NOT NULL,
    "ktpStoragePath" TEXT,
    "proofStoragePath" TEXT,
    "status" "RegistrationStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedByAdminId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdGoverningBodyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoverningBodyRegistration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoverningBody" (
    "id" TEXT NOT NULL,
    "kind" "GoverningBodyKind" NOT NULL,
    "name" TEXT NOT NULL,
    "skNumber" TEXT,
    "street" TEXT NOT NULL,
    "village" TEXT NOT NULL,
    "district" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "postalCode" TEXT,
    "code" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "deactivatedAt" TIMESTAMP(3),
    "deactivationReason" TEXT,
    "deactivatedByAdminId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoverningBody_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GoverningBodyAdmin" (
    "id" TEXT NOT NULL,
    "governingBodyId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'PENDING',
    "approvedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GoverningBodyAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GoverningBodyRegistration_createdGoverningBodyId_key" ON "GoverningBodyRegistration"("createdGoverningBodyId");

-- CreateIndex
CREATE INDEX "GoverningBodyRegistration_status_idx" ON "GoverningBodyRegistration"("status");

-- CreateIndex
CREATE INDEX "GoverningBodyRegistration_applicantUserId_idx" ON "GoverningBodyRegistration"("applicantUserId");

-- CreateIndex
CREATE INDEX "GoverningBodyRegistration_skNumber_idx" ON "GoverningBodyRegistration"("skNumber");

-- CreateIndex
CREATE UNIQUE INDEX "GoverningBody_skNumber_key" ON "GoverningBody"("skNumber");

-- CreateIndex
CREATE UNIQUE INDEX "GoverningBody_code_key" ON "GoverningBody"("code");

-- CreateIndex
CREATE UNIQUE INDEX "GoverningBody_subdomain_key" ON "GoverningBody"("subdomain");

-- CreateIndex
CREATE INDEX "GoverningBody_deactivatedAt_idx" ON "GoverningBody"("deactivatedAt");

-- CreateIndex
CREATE INDEX "GoverningBodyAdmin_governingBodyId_status_idx" ON "GoverningBodyAdmin"("governingBodyId", "status");

-- CreateIndex
CREATE INDEX "GoverningBodyAdmin_userId_idx" ON "GoverningBodyAdmin"("userId");

-- CreateIndex
CREATE INDEX "RefreshToken_governingBodyId_revokedAt_idx" ON "RefreshToken"("governingBodyId", "revokedAt");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_governingBodyId_fkey" FOREIGN KEY ("governingBodyId") REFERENCES "GoverningBody"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffCode" ADD CONSTRAINT "HandoffCode_governingBodyId_fkey" FOREIGN KEY ("governingBodyId") REFERENCES "GoverningBody"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoverningBodyRegistration" ADD CONSTRAINT "GoverningBodyRegistration_applicantUserId_fkey" FOREIGN KEY ("applicantUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoverningBodyRegistration" ADD CONSTRAINT "GoverningBodyRegistration_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoverningBodyRegistration" ADD CONSTRAINT "GoverningBodyRegistration_createdGoverningBodyId_fkey" FOREIGN KEY ("createdGoverningBodyId") REFERENCES "GoverningBody"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoverningBody" ADD CONSTRAINT "GoverningBody_deactivatedByAdminId_fkey" FOREIGN KEY ("deactivatedByAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoverningBodyAdmin" ADD CONSTRAINT "GoverningBodyAdmin_governingBodyId_fkey" FOREIGN KEY ("governingBodyId") REFERENCES "GoverningBody"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GoverningBodyAdmin" ADD CONSTRAINT "GoverningBodyAdmin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "School" ADD CONSTRAINT "School_governingBodyId_fkey" FOREIGN KEY ("governingBodyId") REFERENCES "GoverningBody"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Appended by hand (governing-body ticket 03): one PENDING-or-ACTIVE admin seat per
-- person per Governing Body. A REJECTED, CANCELLED or LEFT seat must repeat, so one
-- turned down or gone may ask again (ticket 04). Listed in prisma/partial-indexes.sql.
CREATE UNIQUE INDEX "GoverningBodyAdmin_one_live_per_user_per_body"
    ON "GoverningBodyAdmin" ("userId", "governingBodyId")
    WHERE "status" IN ('PENDING', 'ACTIVE');
