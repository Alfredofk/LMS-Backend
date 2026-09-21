-- CreateTable
CREATE TABLE "JoinRequestDetail" (
    "id" TEXT NOT NULL,
    "schoolId" TEXT NOT NULL,
    "membershipId" TEXT NOT NULL,
    "nisn" TEXT,
    "birthDate" TIMESTAMP(3),
    "gradeLevel" INTEGER,
    "nip" TEXT,
    "nuptk" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JoinRequestDetail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JoinRequestDetail_membershipId_key" ON "JoinRequestDetail"("membershipId");

-- CreateIndex
CREATE INDEX "JoinRequestDetail_schoolId_gradeLevel_idx" ON "JoinRequestDetail"("schoolId", "gradeLevel");

-- AddForeignKey
ALTER TABLE "JoinRequestDetail" ADD CONSTRAINT "JoinRequestDetail_schoolId_fkey" FOREIGN KEY ("schoolId") REFERENCES "School"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JoinRequestDetail" ADD CONSTRAINT "JoinRequestDetail_membershipId_fkey" FOREIGN KEY ("membershipId") REFERENCES "SchoolMembership"("id") ON DELETE CASCADE ON UPDATE CASCADE;

