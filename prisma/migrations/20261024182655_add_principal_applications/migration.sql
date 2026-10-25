-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "PrincipalApplication" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "applicantPhone" TEXT NOT NULL,
    "ktpStoragePath" TEXT,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PrincipalApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PrincipalApplication_schoolId_status_idx" ON "PrincipalApplication"("schoolId", "status");

-- CreateIndex
CREATE INDEX "PrincipalApplication_userId_idx" ON "PrincipalApplication"("userId");

-- AddForeignKey
ALTER TABLE "PrincipalApplication" ADD CONSTRAINT "PrincipalApplication_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrincipalApplication" ADD CONSTRAINT "PrincipalApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PrincipalApplication" ADD CONSTRAINT "PrincipalApplication_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Appended by hand from prisma/partial-indexes.sql (governing-body ticket 06): one
-- application waiting per person per School. A decided or cancelled one must repeat.
CREATE UNIQUE INDEX "PrincipalApplication_one_pending_per_user_per_school"
    ON "PrincipalApplication" ("userId", "schoolId")
    WHERE "status" = 'PENDING';
