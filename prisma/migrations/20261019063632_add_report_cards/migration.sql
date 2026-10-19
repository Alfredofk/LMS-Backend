-- AlterEnum
ALTER TYPE "ApprovalAction" ADD VALUE 'CLOSE_SEMESTER';

-- CreateTable
CREATE TABLE "ReportCard" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "semesterId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "classId" TEXT NOT NULL,
    "reportDate" TIMESTAMP(3) NOT NULL,
    "schoolName" TEXT NOT NULL,
    "studentName" TEXT NOT NULL,
    "nisn" TEXT NOT NULL,
    "className" TEXT NOT NULL,
    "academicYearLabel" TEXT NOT NULL,
    "semesterOrdinal" INTEGER NOT NULL,
    "homeroomTeacherName" TEXT,
    "homeroomTeacherNip" TEXT,
    "principalName" TEXT NOT NULL,
    "principalNip" TEXT,
    "sick" INTEGER NOT NULL,
    "excused" INTEGER NOT NULL,
    "absent" INTEGER NOT NULL,
    "note" TEXT NOT NULL,
    "closedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReportCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReportCardSubject" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "reportCardId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "subjectCode" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL,
    "finalGrade" INTEGER NOT NULL,
    "kktp" INTEGER NOT NULL,
    "description" TEXT,

    CONSTRAINT "ReportCardSubject_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReportCard_schoolId_idx" ON "ReportCard"("schoolId");

-- CreateIndex
CREATE INDEX "ReportCard_classId_semesterId_idx" ON "ReportCard"("classId", "semesterId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportCard_semesterId_studentProfileId_version_key" ON "ReportCard"("semesterId", "studentProfileId", "version");

-- CreateIndex
CREATE INDEX "ReportCardSubject_schoolId_idx" ON "ReportCardSubject"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "ReportCardSubject_reportCardId_subjectId_key" ON "ReportCardSubject"("reportCardId", "subjectId");

-- AddForeignKey
ALTER TABLE "ReportCard" ADD CONSTRAINT "ReportCard_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportCard" ADD CONSTRAINT "ReportCard_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportCard" ADD CONSTRAINT "ReportCard_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportCard" ADD CONSTRAINT "ReportCard_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportCardSubject" ADD CONSTRAINT "ReportCardSubject_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportCardSubject" ADD CONSTRAINT "ReportCardSubject_reportCardId_fkey" FOREIGN KEY ("reportCardId") REFERENCES "ReportCard"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportCardSubject" ADD CONSTRAINT "ReportCardSubject_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReportCardSubject" ADD CONSTRAINT "ReportCardSubject_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Appended by hand (grading-and-report-card ticket 05, spec invariant 3): a Report Card
-- is frozen in the database itself, as Score and LearningEvent are. Every UPDATE of a
-- ReportCard or a ReportCardSubject is refused; a DELETE only in a transaction that ran
-- SET LOCAL lms.allow_report_card_delete = 'on', which only the test-data cleanup
-- (.scratch/registration-and-membership/probes/cleanup-test-data.mjs) does. A reopen's
-- next close writes a new version (ticket 06).
CREATE FUNCTION "report_card_append_only"() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('lms.allow_report_card_delete', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ReportCard_append_only"
    BEFORE UPDATE OR DELETE ON "ReportCard"
    FOR EACH ROW EXECUTE FUNCTION "report_card_append_only"();

CREATE TRIGGER "ReportCardSubject_append_only"
    BEFORE UPDATE OR DELETE ON "ReportCardSubject"
    FOR EACH ROW EXECUTE FUNCTION "report_card_append_only"();
