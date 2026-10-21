-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'UPDATE_SUBDOMAIN';

-- AlterTable, by hand (governing-body ticket 02, the owner's option A of 2026-10-21):
-- the column cannot be added NOT NULL to a table holding Schools, and the K9 rule
-- that names a subdomain is code, not SQL. So every School is given a placeholder
-- from its NPSN first - unique, as the NPSN is, and never a K9 subdomain, which
-- always starts sd, smp, sma or smk - and the column made required after.
-- prisma/backfill-school-subdomains.js then replaces each placeholder with its K9
-- subdomain, oldest School first. A deploy never fails on a database that holds
-- Schools; the script is safe to run again.
ALTER TABLE "School" ADD COLUMN     "subdomain" TEXT;
UPDATE "School" SET "subdomain" = 'npsn' || "npsn";
ALTER TABLE "School" ALTER COLUMN "subdomain" SET NOT NULL;

-- CreateTable
CREATE TABLE "HandoffCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "sourceTokenId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sessionExpiresAt" TIMESTAMP(3) NOT NULL,
    "rememberMe" BOOLEAN NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HandoffCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "HandoffCode_codeHash_key" ON "HandoffCode"("codeHash");

-- CreateIndex
CREATE INDEX "HandoffCode_userId_idx" ON "HandoffCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "School_subdomain_key" ON "School"("subdomain");

-- AddForeignKey
ALTER TABLE "HandoffCode" ADD CONSTRAINT "HandoffCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HandoffCode" ADD CONSTRAINT "HandoffCode_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;
