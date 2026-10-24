-- AlterTable
ALTER TABLE "GoverningBodyRegistration" ADD COLUMN     "npyp" TEXT;

-- AlterTable
ALTER TABLE "GoverningBody" ADD COLUMN     "npyp" TEXT;

-- CreateIndex
CREATE INDEX "GoverningBodyRegistration_npyp_idx" ON "GoverningBodyRegistration"("npyp");

-- CreateIndex
CREATE UNIQUE INDEX "GoverningBody_npyp_key" ON "GoverningBody"("npyp");

