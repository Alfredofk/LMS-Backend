-- DropIndex
DROP INDEX "StudentProfile_schoolId_nisn_key";

-- DropIndex
DROP INDEX "TeacherProfile_schoolId_nip_key";

-- DropIndex
DROP INDEX "TeacherProfile_schoolId_nuptk_key";

-- AlterTable
ALTER TABLE "StudentProfile" ADD COLUMN     "endedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "TeacherProfile" ADD COLUMN     "endedAt" TIMESTAMP(3);

-- Appended by hand (owner's yes on 2026-09-26 to dropping the three unique
-- indexes above). A student or teacher who left may come back to the same
-- school: the new membership gets a new profile, and the ended one stays with
-- its LEFT membership as history. So NISN, NIP and NUPTK are unique among live
-- profiles only. Mirrored in prisma/partial-indexes.sql.
--
-- Profiles of memberships that already ended take their end from the membership
-- first, so the indexes below see them as ended. No row is deleted.
UPDATE "StudentProfile" AS p
    SET "endedAt" = COALESCE(m."endedAt", CURRENT_TIMESTAMP)
    FROM "SchoolMembership" AS m
    WHERE m."id" = p."membershipId" AND m."status" = 'LEFT';

UPDATE "TeacherProfile" AS p
    SET "endedAt" = COALESCE(m."endedAt", CURRENT_TIMESTAMP)
    FROM "SchoolMembership" AS m
    WHERE m."id" = p."membershipId" AND m."status" = 'LEFT';

CREATE UNIQUE INDEX "StudentProfile_live_nisn_per_school"
    ON "StudentProfile" ("schoolId", "nisn")
    WHERE "endedAt" IS NULL;

CREATE UNIQUE INDEX "TeacherProfile_live_nip_per_school"
    ON "TeacherProfile" ("schoolId", "nip")
    WHERE "endedAt" IS NULL;

CREATE UNIQUE INDEX "TeacherProfile_live_nuptk_per_school"
    ON "TeacherProfile" ("schoolId", "nuptk")
    WHERE "endedAt" IS NULL;
