-- AlterTable
ALTER TABLE "ClassSubject" ADD COLUMN     "endedAt" TIMESTAMP(3);

-- Appended by hand (ticket 08, owner's explicit yes on 2026-09-24): a teacher who
-- leaves ends their ClassSubjects with endedAt instead of a status change, so the
-- slot rule must ignore ended rows. The index is recreated, not altered - Postgres
-- cannot change a partial index's predicate in place. No row is touched.
DROP INDEX "ClassSubject_one_pending_or_active_per_slot";

CREATE UNIQUE INDEX "ClassSubject_one_pending_or_active_per_slot"
    ON "ClassSubject" ("classId", "subjectId", "semesterId")
    WHERE "status" IN ('PENDING', 'ACTIVE') AND "endedAt" IS NULL;
