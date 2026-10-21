-- AlterTable
ALTER TABLE "ReportCard" ADD COLUMN     "extracurricularTable" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "personalityTable" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "ReportCardSubject" ADD COLUMN     "averageKuis" INTEGER,
ADD COLUMN     "averageTugas" INTEGER,
ADD COLUMN     "averageUas" INTEGER,
ADD COLUMN     "averageUts" INTEGER;

-- AlterTable
ALTER TABLE "SchoolGradeSetting" ADD COLUMN     "extracurricularTable" BOOLEAN,
ADD COLUMN     "personalityTable" BOOLEAN;
