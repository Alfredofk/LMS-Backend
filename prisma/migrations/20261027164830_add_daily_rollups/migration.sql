-- CreateTable
CREATE TABLE "SlotDailyRollup" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "semesterId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "localDate" DATE NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "studentsPlacedNow" INTEGER NOT NULL,
    "attendancePresent" INTEGER NOT NULL,
    "attendanceCounted" INTEGER NOT NULL,
    "contentCompleted" INTEGER NOT NULL,
    "contentPossible" INTEGER NOT NULL,
    "gradeSum" INTEGER NOT NULL,
    "gradeCount" INTEGER NOT NULL,
    "belowKktp" INTEGER NOT NULL,
    "withSignal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SlotDailyRollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClassDailyRollup" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "semesterId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "localDate" DATE NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "studentsPlacedNow" INTEGER NOT NULL,
    "attendancePresent" INTEGER NOT NULL,
    "attendanceCounted" INTEGER NOT NULL,
    "contentCompleted" INTEGER NOT NULL,
    "contentPossible" INTEGER NOT NULL,
    "gradeSum" INTEGER NOT NULL,
    "gradeCount" INTEGER NOT NULL,
    "belowKktp" INTEGER NOT NULL,
    "withSignal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClassDailyRollup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchoolDailyRollup" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "semesterId" TEXT NOT NULL,
    "localDate" DATE NOT NULL,
    "takenAt" TIMESTAMP(3) NOT NULL,
    "studentsPlacedNow" INTEGER NOT NULL,
    "attendancePresent" INTEGER NOT NULL,
    "attendanceCounted" INTEGER NOT NULL,
    "contentCompleted" INTEGER NOT NULL,
    "contentPossible" INTEGER NOT NULL,
    "gradeSum" INTEGER NOT NULL,
    "gradeCount" INTEGER NOT NULL,
    "belowKktp" INTEGER NOT NULL,
    "withSignal" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SchoolDailyRollup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlotDailyRollup_schoolId_semesterId_localDate_idx" ON "SlotDailyRollup"("schoolId", "semesterId", "localDate");

-- CreateIndex
CREATE UNIQUE INDEX "SlotDailyRollup_classId_subjectId_localDate_key" ON "SlotDailyRollup"("classId", "subjectId", "localDate");

-- CreateIndex
CREATE INDEX "ClassDailyRollup_schoolId_semesterId_localDate_idx" ON "ClassDailyRollup"("schoolId", "semesterId", "localDate");

-- CreateIndex
CREATE UNIQUE INDEX "ClassDailyRollup_classId_localDate_key" ON "ClassDailyRollup"("classId", "localDate");

-- CreateIndex
CREATE INDEX "SchoolDailyRollup_schoolId_semesterId_localDate_idx" ON "SchoolDailyRollup"("schoolId", "semesterId", "localDate");

-- CreateIndex
CREATE UNIQUE INDEX "SchoolDailyRollup_schoolId_localDate_key" ON "SchoolDailyRollup"("schoolId", "localDate");

-- AddForeignKey
ALTER TABLE "SlotDailyRollup" ADD CONSTRAINT "SlotDailyRollup_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotDailyRollup" ADD CONSTRAINT "SlotDailyRollup_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotDailyRollup" ADD CONSTRAINT "SlotDailyRollup_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotDailyRollup" ADD CONSTRAINT "SlotDailyRollup_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassDailyRollup" ADD CONSTRAINT "ClassDailyRollup_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassDailyRollup" ADD CONSTRAINT "ClassDailyRollup_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClassDailyRollup" ADD CONSTRAINT "ClassDailyRollup_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolDailyRollup" ADD CONSTRAINT "SchoolDailyRollup_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolDailyRollup" ADD CONSTRAINT "SchoolDailyRollup_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester"("id") ON DELETE CASCADE ON UPDATE CASCADE;
