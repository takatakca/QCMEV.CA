-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditEventType" ADD VALUE 'API_KEY_CREATED';
ALTER TYPE "AuditEventType" ADD VALUE 'API_KEY_REVOKED';

-- AlterTable
ALTER TABLE "Device" ADD COLUMN     "externalId" TEXT;

-- AlterTable
ALTER TABLE "SEVUser" ADD COLUMN     "externalId" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "externalRef" TEXT,
ADD COLUMN     "receiptToken" TEXT,
ADD COLUMN     "source" TEXT;

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_operatorId_idx" ON "ApiKey"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_operatorId_externalId_key" ON "Device"("operatorId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "SEVUser_operatorId_externalId_key" ON "SEVUser"("operatorId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_receiptToken_key" ON "Transaction"("receiptToken");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_operatorId_source_externalRef_key" ON "Transaction"("operatorId", "source", "externalRef");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "SEVUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

