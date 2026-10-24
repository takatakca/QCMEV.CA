-- CreateEnum
CREATE TYPE "SectorType" AS ENUM ('RST', 'TRP');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('CASH_REGISTER', 'TABLET', 'MOBILE', 'SERVER');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'CASHIER');

-- CreateEnum
CREATE TYPE "CertificateType" AS ENUM ('OPERATOR', 'DEVICE');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('ADDITION', 'CLOSING_RECEIPT', 'CREDIT_NOTE', 'ESTIMATION', 'QUOTE', 'DUPLICATE', 'REPRODUCTION', 'CANCELLATION', 'CORRECTION', 'TRAINING');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('DRAFT', 'INVOICED', 'CANCELLED', 'CORRECTED');

-- CreateEnum
CREATE TYPE "MevStatus" AS ENUM ('PENDING', 'SUBMITTED', 'ACCEPTED', 'REJECTED', 'QUEUED_OFFLINE');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('CASH', 'CREDIT_CARD', 'DEBIT_CARD', 'CHEQUE', 'GIFT_CARD', 'MIXED', 'OTHER');

-- CreateEnum
CREATE TYPE "PrintMode" AS ENUM ('PAPER', 'ELECTRONIC', 'NO_PRINT');

-- CreateEnum
CREATE TYPE "ModificationType" AS ENUM ('ADD_ITEM', 'REMOVE_ITEM', 'MODIFY_PRICE', 'MODIFY_TAX_CODE', 'MODIFY_QUANTITY');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('USER_REPORT');

-- CreateEnum
CREATE TYPE "ConventionType" AS ENUM ('THIRD_PARTY');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('TRANSACTION_CREATED', 'TRANSACTION_MODIFIED', 'TRANSACTION_CANCELLED', 'TRANSACTION_CORRECTED', 'CERTIFICATE_REQUESTED', 'CERTIFICATE_RECEIVED', 'USER_REGISTERED', 'USER_LOGIN', 'USER_LOGIN_FAILED', 'USER_LOGOUT', 'USER_REPORT_GENERATED', 'OFFLINE_MODE_ACTIVATED', 'OFFLINE_MODE_DEACTIVATED', 'BATCH_SUBMITTED', 'MEV_SUBMISSION_FAILED', 'MEV_ERROR', 'AUTH_LOGIN', 'AUTH_LOGOUT', 'SYSTEM_ERROR');

-- CreateEnum
CREATE TYPE "LogSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "MevRequestType" AS ENUM ('CRT', 'UTL', 'TRX', 'DOC');

-- CreateEnum
CREATE TYPE "MevEnvironment" AS ENUM ('SIMULATOR', 'DEVELOPMENT', 'TESTING', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "neq" TEXT NOT NULL,
    "tpsNumber" TEXT,
    "tvqNumber" TEXT,
    "sector" "SectorType" NOT NULL,
    "authorizationCode" TEXT,
    "serverAuthCode" TEXT,
    "sevCertificationCode" TEXT,
    "sevVersion" TEXT NOT NULL DEFAULT '1.0.0',
    "address" TEXT,
    "city" TEXT,
    "province" TEXT DEFAULT 'QC',
    "postalCode" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "environment" "MevEnvironment" NOT NULL DEFAULT 'SIMULATOR',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Operator_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "serialNumber" TEXT NOT NULL,
    "deviceType" "DeviceType" NOT NULL,
    "description" TEXT,
    "offlineMode" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SEVUser" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'CASHIER',
    "mevUserId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SEVUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Certificate" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "type" "CertificateType" NOT NULL,
    "serialNumber" TEXT,
    "subject" TEXT,
    "issuer" TEXT,
    "validFrom" TIMESTAMP(3),
    "validTo" TIMESTAMP(3),
    "pemCertificate" TEXT,
    "encryptedPrivateKey" TEXT,
    "csrPem" TEXT,
    "mevKeyId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transactionNumber" INTEGER NOT NULL,
    "civilDate" TEXT NOT NULL,
    "transactionType" "TransactionType" NOT NULL,
    "status" "TransactionStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(12,4) NOT NULL,
    "tpsAmount" DECIMAL(12,4) NOT NULL,
    "tvqAmount" DECIMAL(12,4) NOT NULL,
    "totalAmount" DECIMAL(12,4) NOT NULL,
    "tipsAmount" DECIMAL(12,4),
    "discountAmount" DECIMAL(12,4),
    "paymentMode" "PaymentMode" NOT NULL,
    "printMode" "PrintMode" NOT NULL DEFAULT 'PAPER',
    "tableNumber" TEXT,
    "numberOfCovers" INTEGER,
    "taxCode" TEXT,
    "hashChain" TEXT,
    "mevTransactionNumber" TEXT,
    "mevSubmissionStatus" "MevStatus" NOT NULL DEFAULT 'PENDING',
    "mevSubmittedAt" TIMESTAMP(3),
    "mevResponse" JSONB,
    "qrCodeUrl" TEXT,
    "certifiedData" TEXT,
    "isTraining" BOOLEAN NOT NULL DEFAULT false,
    "relatedTransactionId" TEXT,
    "invoicedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionItem" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,4) NOT NULL,
    "unitPrice" DECIMAL(12,4) NOT NULL,
    "totalPrice" DECIMAL(12,4) NOT NULL,
    "taxCode" TEXT,
    "tpsAmount" DECIMAL(12,4) NOT NULL,
    "tvqAmount" DECIMAL(12,4) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionModification" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "modificationType" "ModificationType" NOT NULL,
    "description" TEXT NOT NULL,
    "previousValue" JSONB,
    "newValue" JSONB,
    "reason" TEXT,
    "performedByUserId" TEXT,
    "performedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionModification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserReport" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "reportType" "ReportType" NOT NULL,
    "reportYear" INTEGER NOT NULL,
    "totalSales" DECIMAL(15,4) NOT NULL,
    "totalTps" DECIMAL(15,4) NOT NULL,
    "totalTvq" DECIMAL(15,4) NOT NULL,
    "totalTransactions" INTEGER NOT NULL,
    "mevReportNumber" TEXT,
    "mevSubmissionStatus" "MevStatus" NOT NULL DEFAULT 'PENDING',
    "submittedAt" TIMESTAMP(3),
    "mevResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ThirdPartyConvention" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "type" "ConventionType" NOT NULL,
    "partnerName" TEXT NOT NULL,
    "partnerNEQ" TEXT NOT NULL,
    "effectiveDate" TIMESTAMP(3) NOT NULL,
    "expiryDate" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ThirdPartyConvention_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT,
    "eventType" "AuditEventType" NOT NULL,
    "severity" "LogSeverity" NOT NULL DEFAULT 'INFO',
    "userId" TEXT,
    "deviceId" TEXT,
    "entityId" TEXT,
    "entityType" TEXT,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MevRequestLog" (
    "id" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "requestType" "MevRequestType" NOT NULL,
    "environment" "MevEnvironment" NOT NULL,
    "requestPayload" JSONB NOT NULL,
    "responsePayload" JSONB,
    "httpStatus" INTEGER,
    "mevErrorCode" TEXT,
    "duration" INTEGER,
    "success" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MevRequestLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfflineQueue" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "requestType" "MevRequestType" NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "lastAttemptAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfflineQueue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Operator_neq_key" ON "Operator"("neq");

-- CreateIndex
CREATE UNIQUE INDEX "Device_serialNumber_key" ON "Device"("serialNumber");

-- CreateIndex
CREATE INDEX "Device_operatorId_idx" ON "Device"("operatorId");

-- CreateIndex
CREATE UNIQUE INDEX "SEVUser_username_key" ON "SEVUser"("username");

-- CreateIndex
CREATE INDEX "SEVUser_operatorId_idx" ON "SEVUser"("operatorId");

-- CreateIndex
CREATE INDEX "Certificate_operatorId_idx" ON "Certificate"("operatorId");

-- CreateIndex
CREATE INDEX "Transaction_operatorId_idx" ON "Transaction"("operatorId");

-- CreateIndex
CREATE INDEX "Transaction_deviceId_idx" ON "Transaction"("deviceId");

-- CreateIndex
CREATE INDEX "Transaction_civilDate_idx" ON "Transaction"("civilDate");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_deviceId_civilDate_transactionNumber_key" ON "Transaction"("deviceId", "civilDate", "transactionNumber");

-- CreateIndex
CREATE INDEX "TransactionItem_transactionId_idx" ON "TransactionItem"("transactionId");

-- CreateIndex
CREATE INDEX "TransactionModification_transactionId_idx" ON "TransactionModification"("transactionId");

-- CreateIndex
CREATE INDEX "UserReport_operatorId_idx" ON "UserReport"("operatorId");

-- CreateIndex
CREATE INDEX "ThirdPartyConvention_operatorId_idx" ON "ThirdPartyConvention"("operatorId");

-- CreateIndex
CREATE INDEX "AuditLog_operatorId_idx" ON "AuditLog"("operatorId");

-- CreateIndex
CREATE INDEX "AuditLog_eventType_idx" ON "AuditLog"("eventType");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE INDEX "MevRequestLog_operatorId_idx" ON "MevRequestLog"("operatorId");

-- CreateIndex
CREATE INDEX "MevRequestLog_requestType_idx" ON "MevRequestLog"("requestType");

-- CreateIndex
CREATE INDEX "OfflineQueue_deviceId_idx" ON "OfflineQueue"("deviceId");

-- CreateIndex
CREATE INDEX "OfflineQueue_status_idx" ON "OfflineQueue"("status");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SEVUser" ADD CONSTRAINT "SEVUser_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "SEVUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionItem" ADD CONSTRAINT "TransactionItem_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TransactionModification" ADD CONSTRAINT "TransactionModification_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserReport" ADD CONSTRAINT "UserReport_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ThirdPartyConvention" ADD CONSTRAINT "ThirdPartyConvention_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MevRequestLog" ADD CONSTRAINT "MevRequestLog_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfflineQueue" ADD CONSTRAINT "OfflineQueue_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

┌─────────────────────────────────────────────────────────┐
│  Update available 5.22.0 -> 8.0.0-rc.27                 │
│                                                         │
│  This is a major update - please follow the guide at    │
│  https://pris.ly/d/major-version-upgrade                │
│                                                         │
│  Run the following to update                            │
│    npm i --save-dev prisma@latest                       │
│    npm i @prisma/client@latest                          │
└─────────────────────────────────────────────────────────┘
