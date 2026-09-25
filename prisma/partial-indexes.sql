-- Partial (filtered) unique indexes.
--
-- Prisma's schema DSL cannot express a WHERE clause on an index, so these
-- rules live here and must be appended by hand to the generated migration:
--
--   npx prisma migrate dev --create-only --name init
--   cat prisma/partial-indexes.sql >> prisma/migrations/<timestamp>_init/migration.sql
--   npx prisma migrate dev
--
-- Do NOT replace these with plain @@unique in schema.prisma. Every one of them
-- must permit repeats of the excluded rows, and a total unique constraint would
-- silently forbid legitimate history.

-- A user may hold only one membership that is pending or active.
-- REJECTED and LEFT rows must repeat: a person can be rejected twice, and
-- moving between schools depends on old LEFT rows staying put (ADR-0004).
CREATE UNIQUE INDEX "SchoolMembership_one_pending_or_active_per_user"
    ON "SchoolMembership" ("userId")
    WHERE "status" IN ('PENDING', 'ACTIVE');

-- One teacher per class + subject + semester.
-- REJECTED rows must repeat, otherwise a single rejected request would block
-- that teaching slot permanently. Ended rows (a teacher who left, ticket 08)
-- must repeat too - recreated with the endedAt condition in
-- 20260923185004_add_class_subject_ended_at.
CREATE UNIQUE INDEX "ClassSubject_one_pending_or_active_per_slot"
    ON "ClassSubject" ("classId", "subjectId", "semesterId")
    WHERE "status" IN ('PENDING', 'ACTIVE') AND "endedAt" IS NULL;

-- A student sits in exactly one class at a time.
-- Ended placements must repeat - that is the archive rollover depends on.
CREATE UNIQUE INDEX "ClassMembership_one_active_per_student"
    ON "ClassMembership" ("studentProfileId")
    WHERE "endedAt" IS NULL;

-- The national subject catalog has no schoolId, and Postgres treats NULLs as
-- distinct, so @@unique([schoolId, code]) does NOT stop two national subjects
-- sharing a code. This closes that gap while leaving each school free to define
-- a local subject whose code matches a national one.
CREATE UNIQUE INDEX "Subject_national_catalog_code_unique"
    ON "Subject" ("code")
    WHERE "schoolId" IS NULL;

-- One class move waiting per student (ticket 16). A move turned down, cancelled
-- or done must repeat - added in 20260924163916_add_leave_request_and_class_move.
CREATE UNIQUE INDEX "ClassMove_one_pending_per_student"
    ON "ClassMove" ("studentProfileId")
    WHERE "status" = 'PENDING';

-- One leave request waiting per membership (ticket 17). A rejected or cancelled
-- request must repeat, or a member turned down once could never ask again.
CREATE UNIQUE INDEX "LeaveRequest_one_pending_per_membership"
    ON "LeaveRequest" ("membershipId")
    WHERE "status" = 'PENDING';
