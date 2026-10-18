-- CreateTable
CREATE TABLE "SlotDescription" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "classId" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "semesterId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "writtenByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SlotDescription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HomeroomNote" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "semesterId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "text" TEXT,
    "writtenByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HomeroomNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SlotDescription_schoolId_idx" ON "SlotDescription"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "SlotDescription_classId_subjectId_semesterId_studentProfile_key" ON "SlotDescription"("classId", "subjectId", "semesterId", "studentProfileId");

-- CreateIndex
CREATE INDEX "HomeroomNote_schoolId_idx" ON "HomeroomNote"("schoolId");

-- CreateIndex
CREATE UNIQUE INDEX "HomeroomNote_semesterId_studentProfileId_key" ON "HomeroomNote"("semesterId", "studentProfileId");

-- AddForeignKey
ALTER TABLE "SlotDescription" ADD CONSTRAINT "SlotDescription_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotDescription" ADD CONSTRAINT "SlotDescription_classId_fkey" FOREIGN KEY ("classId") REFERENCES "Class"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotDescription" ADD CONSTRAINT "SlotDescription_subjectId_fkey" FOREIGN KEY ("subjectId") REFERENCES "Subject"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotDescription" ADD CONSTRAINT "SlotDescription_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SlotDescription" ADD CONSTRAINT "SlotDescription_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeroomNote" ADD CONSTRAINT "HomeroomNote_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeroomNote" ADD CONSTRAINT "HomeroomNote_semesterId_fkey" FOREIGN KEY ("semesterId") REFERENCES "Semester"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HomeroomNote" ADD CONSTRAINT "HomeroomNote_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
