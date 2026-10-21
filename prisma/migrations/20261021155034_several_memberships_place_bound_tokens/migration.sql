-- AlterTable
ALTER TABLE "RefreshToken" ADD COLUMN     "schoolId" TEXT;

-- CreateIndex
CREATE INDEX "RefreshToken_schoolId_revokedAt_idx" ON "RefreshToken"("schoolId", "revokedAt");

-- AddForeignKey
ALTER TABLE "RefreshToken" ADD CONSTRAINT "RefreshToken_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Appended by hand (governing-body ticket 01, the owner's yes of 2026-10-21): one
-- PENDING-or-ACTIVE membership per user per school, at any number of schools,
-- replacing one across every school (ADR-0002's consequence, superseded by
-- ADR-0011). The new rule is looser, so every row already meets it. Created before
-- the old one is dropped, so the table is never without a ceiling.
CREATE UNIQUE INDEX "SchoolMembership_one_live_per_user_per_school"
    ON "SchoolMembership" ("userId", "schoolId")
    WHERE "status" IN ('PENDING', 'ACTIVE');

DROP INDEX "SchoolMembership_one_pending_or_active_per_user";
