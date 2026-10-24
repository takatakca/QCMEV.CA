-- AlterTable
ALTER TABLE "Operator" ADD COLUMN     "addressUtc" TEXT NOT NULL DEFAULT '-05:00';

-- AlterTable
ALTER TABLE "UserReport" ADD COLUMN     "deviceId" TEXT,
ADD COLUMN     "displayJson" JSONB,
ADD COLUMN     "summaryJson" JSONB,
ADD COLUMN     "userId" TEXT;

