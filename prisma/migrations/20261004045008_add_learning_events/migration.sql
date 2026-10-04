-- CreateTable
CREATE TABLE "LearningEvent" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "actorMembershipId" TEXT NOT NULL,
    "verb" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT NOT NULL,
    "context" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LearningEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentProgress" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "firstOpenedAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "videoPositionSeconds" DOUBLE PRECISION,
    "videoDurationSeconds" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentProgress_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LearningEvent_schoolId_actorMembershipId_occurredAt_idx" ON "LearningEvent"("schoolId", "actorMembershipId", "occurredAt");

-- CreateIndex
CREATE INDEX "LearningEvent_objectType_objectId_idx" ON "LearningEvent"("objectType", "objectId");

-- CreateIndex
CREATE INDEX "ContentProgress_schoolId_idx" ON "ContentProgress"("schoolId");

-- CreateIndex
CREATE INDEX "ContentProgress_studentProfileId_idx" ON "ContentProgress"("studentProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentProgress_contentId_studentProfileId_key" ON "ContentProgress"("contentId", "studentProfileId");

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearningEvent" ADD CONSTRAINT "LearningEvent_actorMembershipId_fkey" FOREIGN KEY ("actorMembershipId") REFERENCES "SchoolMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProgress" ADD CONSTRAINT "ContentProgress_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProgress" ADD CONSTRAINT "ContentProgress_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "Content"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentProgress" ADD CONSTRAINT "ContentProgress_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Appended by hand (teaching-and-learning 05, owner 2026-10-04): LearningEvent is
-- append-only in the database itself, not only in the code (handoff #26).
--
-- Every UPDATE is refused. Every DELETE is refused too, unless the transaction has
-- run SET LOCAL lms.allow_learning_event_delete = 'on' - which only the test-data
-- cleanup (.scratch/.../cleanup-test-data.mjs) does. A school or membership deleted
-- by hand therefore fails on its events instead of taking them with it.
-- current_setting(..., true) answers NULL rather than raising when it was never set.
CREATE FUNCTION "learning_event_append_only"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('lms.allow_learning_event_delete', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'LearningEvent is append-only: % refused', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LearningEvent_append_only"
    BEFORE UPDATE OR DELETE ON "LearningEvent"
    FOR EACH ROW EXECUTE FUNCTION "learning_event_append_only"();
