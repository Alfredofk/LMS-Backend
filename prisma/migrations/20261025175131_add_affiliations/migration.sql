-- CreateEnum
CREATE TYPE "AffiliationStart" AS ENUM ('CREATED', 'JOINED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ApprovalAction" ADD VALUE 'JOIN';
ALTER TYPE "ApprovalAction" ADD VALUE 'RELEASE';

-- CreateTable
CREATE TABLE "AffiliationRequest" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "governingBodyId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AffiliationRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolAffiliation" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "governingBodyId" TEXT NOT NULL,
    "began" "AffiliationStart" NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedByUserId" TEXT,
    "affiliationRequestId" TEXT,
    "endedAt" TIMESTAMP(3),
    "endedByUserId" TEXT,
    "endReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolAffiliation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AffiliationRequest_governingBodyId_status_idx" ON "AffiliationRequest"("governingBodyId", "status");

-- CreateIndex
CREATE INDEX "AffiliationRequest_schoolId_idx" ON "AffiliationRequest"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolAffiliation_affiliationRequestId_key" ON "SchoolAffiliation"("affiliationRequestId");

-- CreateIndex
CREATE INDEX "SchoolAffiliation_schoolId_startedAt_idx" ON "SchoolAffiliation"("schoolId", "startedAt");

-- CreateIndex
CREATE INDEX "SchoolAffiliation_governingBodyId_idx" ON "SchoolAffiliation"("governingBodyId");

-- AddForeignKey
ALTER TABLE "AffiliationRequest" ADD CONSTRAINT "AffiliationRequest_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliationRequest" ADD CONSTRAINT "AffiliationRequest_governingBodyId_fkey" FOREIGN KEY ("governingBodyId") REFERENCES "GoverningBody"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliationRequest" ADD CONSTRAINT "AffiliationRequest_requestedByUserId_fkey" FOREIGN KEY ("requestedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AffiliationRequest" ADD CONSTRAINT "AffiliationRequest_decidedByUserId_fkey" FOREIGN KEY ("decidedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolAffiliation" ADD CONSTRAINT "SchoolAffiliation_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolAffiliation" ADD CONSTRAINT "SchoolAffiliation_governingBodyId_fkey" FOREIGN KEY ("governingBodyId") REFERENCES "GoverningBody"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolAffiliation" ADD CONSTRAINT "SchoolAffiliation_startedByUserId_fkey" FOREIGN KEY ("startedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolAffiliation" ADD CONSTRAINT "SchoolAffiliation_endedByUserId_fkey" FOREIGN KEY ("endedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolAffiliation" ADD CONSTRAINT "SchoolAffiliation_affiliationRequestId_fkey" FOREIGN KEY ("affiliationRequestId") REFERENCES "AffiliationRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Appended by hand from prisma/partial-indexes.sql (governing-body ticket 08): one
-- Affiliation Request waiting per School, and one open SchoolAffiliation per School. A
-- decided request and an ended affiliation must repeat.
CREATE UNIQUE INDEX "AffiliationRequest_one_pending_per_school"
    ON "AffiliationRequest" ("schoolId")
    WHERE "status" = 'PENDING';

CREATE UNIQUE INDEX "SchoolAffiliation_one_open_per_school"
    ON "SchoolAffiliation" ("schoolId")
    WHERE "endedAt" IS NULL;

-- Filled by hand (governing-body ticket 08): every School already under a Governing Body
-- was created by it (ticket 05), so each gets its open row, started when the School was, by
-- the admin its CREATE audit names. Nothing is changed or removed.
INSERT INTO "SchoolAffiliation"
    ("id", "schoolId", "governingBodyId", "began", "startedAt", "startedByUserId", "createdAt", "updatedAt")
SELECT
    'aff' || md5(s."id"),
    s."id",
    s."governingBodyId",
    'CREATED',
    s."createdAt",
    (
        SELECT a."actorUserId" FROM "ApprovalAudit" a
        WHERE a."subjectType" = 'School' AND a."subjectId" = s."id" AND a."action" = 'CREATE'
        ORDER BY a."createdAt"
        LIMIT 1
    ),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "School" s
WHERE s."governingBodyId" IS NOT NULL;
