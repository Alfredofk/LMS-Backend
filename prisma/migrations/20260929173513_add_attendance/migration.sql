-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'SICK', 'EXCUSED', 'ABSENT');

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "completedByUserId" TEXT;

-- CreateTable
CREATE TABLE "Attendance" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentProfileId" TEXT NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "checkedInAt" TIMESTAMP(3),
    "outsideSchool" BOOLEAN NOT NULL DEFAULT false,
    "late" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttendanceChange" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "attendanceId" TEXT NOT NULL,
    "fromStatus" "AttendanceStatus" NOT NULL,
    "toStatus" "AttendanceStatus" NOT NULL,
    "note" TEXT,
    "changedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttendanceChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Attendance_schoolId_sessionId_idx" ON "Attendance"("schoolId", "sessionId");

-- CreateIndex
CREATE INDEX "Attendance_studentProfileId_idx" ON "Attendance"("studentProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "Attendance_sessionId_studentProfileId_key" ON "Attendance"("sessionId", "studentProfileId");

-- CreateIndex
CREATE INDEX "AttendanceChange_attendanceId_createdAt_idx" ON "AttendanceChange"("attendanceId", "createdAt");

-- CreateIndex
CREATE INDEX "AttendanceChange_schoolId_idx" ON "AttendanceChange"("schoolId");

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attendance" ADD CONSTRAINT "Attendance_studentProfileId_fkey" FOREIGN KEY ("studentProfileId") REFERENCES "StudentProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceChange" ADD CONSTRAINT "AttendanceChange_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttendanceChange" ADD CONSTRAINT "AttendanceChange_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance"("id") ON DELETE CASCADE ON UPDATE CASCADE;
