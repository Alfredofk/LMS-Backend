-- CreateTable
CREATE TABLE "SchoolJointLeaveChoice" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "nationalHolidayId" TEXT NOT NULL,
    "observed" BOOLEAN,
    "decidedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SchoolJointLeaveChoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SchoolJointLeaveChoice_schoolId_nationalHolidayId_key" ON "SchoolJointLeaveChoice"("schoolId", "nationalHolidayId");

-- AddForeignKey
ALTER TABLE "SchoolJointLeaveChoice" ADD CONSTRAINT "SchoolJointLeaveChoice_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SchoolJointLeaveChoice" ADD CONSTRAINT "SchoolJointLeaveChoice_nationalHolidayId_fkey" FOREIGN KEY ("nationalHolidayId") REFERENCES "NationalHoliday"("id") ON DELETE CASCADE ON UPDATE CASCADE;
