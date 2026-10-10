-- AlterEnum
ALTER TYPE "SubmissionClose" ADD VALUE 'TEACHER';

-- AlterTable
ALTER TABLE "Assessment" ADD COLUMN     "releasedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Submission" ADD COLUMN     "comment" TEXT,
ADD COLUMN     "offlineMark" DECIMAL(5,2),
ADD COLUMN     "releasedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SubmissionAnswer" ADD COLUMN     "comment" TEXT,
ADD COLUMN     "teacherPoints" DECIMAL(7,4);

-- CreateTable
CREATE TABLE "Score" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "value" DECIMAL(5,2) NOT NULL,
    "pointsEarned" DECIMAL(9,4),
    "pointsTotal" INTEGER,
    "reason" TEXT,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedByUserId" TEXT NOT NULL,

    CONSTRAINT "Score_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Score_submissionId_recordedAt_idx" ON "Score"("submissionId", "recordedAt");

-- CreateIndex
CREATE INDEX "Score_schoolId_idx" ON "Score"("schoolId");

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Score" ADD CONSTRAINT "Score_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "Submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Appended by hand (assessment ticket 04, handoff #26): a Score is append-only in
-- the database itself, as LearningEvent is. Every UPDATE is refused; a DELETE only
-- in a transaction that ran SET LOCAL lms.allow_score_delete = 'on', which only the
-- test-data cleanup (.scratch/registration-and-membership/probes/cleanup-test-data.mjs)
-- does. A correction is a new row with its reason.
CREATE FUNCTION "score_append_only"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('lms.allow_score_delete', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Score is append-only: % refused', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Score_append_only"
    BEFORE UPDATE OR DELETE ON "Score"
    FOR EACH ROW EXECUTE FUNCTION "score_append_only"();
