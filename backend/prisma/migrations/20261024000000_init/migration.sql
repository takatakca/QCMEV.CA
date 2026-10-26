-- CreateEnum
CREATE TYPE "SectorType" AS ENUM ('RBC', 'TRP');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('CASH_REGISTER', 'TABLET', 'MOBILE', 'SERVER');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('ADMIN', 'MANAGER', 'CASHIER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "CertificateType" AS ENUM ('SEV', 'MEV_WEB');

-- CreateEnum
CREATE TYPE "MevEnvironment" AS ENUM ('SIMULATOR', 'DEV', 'ESSAI', 'PROD');

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('ADDI', 'ESTM', 'RFER', 'SOUM');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('RECEIPT', 'CREDIT_NOTE', 'ADDITION', 'ESTIMATE', 'QUOTE');

-- CreateEnum
CREATE TYPE "TransactionStatus" AS ENUM ('ISSUED', 'CREDITED', 'PARTIALLY_CREDITED');

-- CreateEnum
CREATE TYPE "MevStatus" AS ENUM ('PENDING', 'ACCEPTED', 'OFFLINE_PENDING', 'RETRY_BATCH', 'REJECTED');

-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('ARG', 'CHQ', 'CRE', 'DEB', 'CPR', 'MIX', 'AUT', 'INC', 'AUC');

-- CreateEnum
CREATE TYPE "PrintMode" AS ENUM ('FAC', 'RPR', 'DUP', 'ANN', 'PSP');

-- CreateEnum
CREATE TYPE "PrintFormat" AS ENUM ('PAP', 'ELE', 'PEL', 'NON');

-- CreateEnum
CREATE TYPE "TransactionMode" AS ENUM ('OPE', 'FOR');

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('CMP', 'LVR', 'LVT', 'TBL');

-- CreateEnum
CREATE TYPE "ItemTax" AS ENUM ('FP', 'F', 'P', 'NON');

-- CreateEnum
CREATE TYPE "ItemActivity" AS ENUM ('RES', 'BAR', 'NON');

-- CreateEnum
CREATE TYPE "ModificationType" AS ENUM ('ADD_ITEM', 'REMOVE_ITEM', 'MODIFY_PRICE', 'CREDIT_NOTE', 'REPRINT');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('RUT');

-- CreateEnum
CREATE TYPE "ConventionType" AS ENUM ('THIRD_PARTY');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('TRANSACTION_CREATED', 'TRANSACTION_MODIFIED', 'TRANSACTION_CREDITED', 'TRANSACTION_REPRINTED', 'CERTIFICATE_REQUESTED', 'CERTIFICATE_RECEIVED', 'CERTIFICATE_REVOKED', 'USER_REGISTERED', 'USER_REPORT_GENERATED', 'OFFLINE_MODE_ACTIVATED', 'OFFLINE_MODE_DEACTIVATED', 'OFFLINE_DEADLINE_WARNING', 'BATCH_SUBMITTED', 'MEV_ERROR', 'AUTH_LOGIN', 'AUTH_LOGIN_FAILED', 'SETTINGS_CHANGED', 'INTEGRATION_SALE', 'INTEGRATION_REJECTED', 'SYSTEM_ERROR');

-- CreateEnum
CREATE TYPE "LogSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "MevRequestType" AS ENUM ('CRT', 'UTL', 'TRX', 'DOC');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "ExternalSaleKind" AS ENUM ('SALE', 'CREDIT_NOTE', 'PRINT');

-- CreateEnum
CREATE TYPE "ExternalSaleStatus" AS ENUM ('PROCESSING', 'DONE');

-- CreateTable
CREATE TABLE "Operator" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "neq" TEXT NOT NULL,
    "noTPS" TEXT NOT NULL,
    "noTVQ" TEXT NOT NULL,
    "sector" "SectorType" NOT NULL DEFAULT 'RBC',
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
    "deviceType" "DeviceType" NOT NULL DEFAULT 'SERVER',
    "name" TEXT,
    "model" TEXT,
    "firmwareVersion" TEXT,
    "description" TEXT,
    "fileNumber" TEXT,
    "authorizationCodeEnc" TEXT,
    "mevDeviceId" TEXT,
    "offlineMode" BOOLEAN NOT NULL DEFAULT false,
    "offlineSince" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
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
    "passwordHash" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'CASHIER',
    "mevUserName" TEXT,
    "mevRegisteredAt" TIMESTAMP(3),
    "mevUserId" TEXT,
    "externalId" TEXT,
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
    "deviceId" TEXT,
    "type" "CertificateType" NOT NULL,
    "serialNumber" TEXT,
    "subject" TEXT,
    "issuer" TEXT,
    "thumbprint" TEXT,
    "validFrom" TIMESTAMP(3),
    "validUntil" TIMESTAMP(3),
    "pemCertificate" TEXT,
    "encryptedPrivateKey" TEXT,
    "csrPem" TEXT,
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
    "noTrans" TEXT NOT NULL,
    "civilDate" TEXT NOT NULL,
    "datTrans" TEXT NOT NULL,
    "utcOffset" TEXT NOT NULL,
    "deviceSeq" INTEGER NOT NULL,
    "transactionType" "TransactionType" NOT NULL,
    "documentKind" "DocumentKind" NOT NULL,
    "transactionMode" "TransactionMode" NOT NULL DEFAULT 'OPE',
    "printMode" "PrintMode" NOT NULL DEFAULT 'FAC',
    "printFormat" "PrintFormat" NOT NULL DEFAULT 'PAP',
    "serviceType" "ServiceType",
    "sector" "SectorType" NOT NULL DEFAULT 'RBC',
    "tableNumber" TEXT,
    "numberOfCovers" INTEGER,
    "ecommerce" BOOLEAN NOT NULL DEFAULT false,
    "paymentMode" "PaymentMode" NOT NULL,
    "subtotalCents" INTEGER NOT NULL,
    "tpsCents" INTEGER NOT NULL,
    "tvqCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "tipCents" INTEGER,
    "adjustCents" INTEGER,
    "amountDueCents" INTEGER,
    "status" "TransactionStatus" NOT NULL DEFAULT 'ISSUED',
    "mevStatus" "MevStatus" NOT NULL DEFAULT 'PENDING',
    "signature" TEXT NOT NULL,
    "previousSignature" TEXT NOT NULL,
    "signedAt" TEXT NOT NULL,
    "hashChain" TEXT NOT NULL,
    "requestJson" JSONB NOT NULL,
    "mevTransactionNumber" TEXT,
    "mevProcessedAt" TEXT,
    "mevSubmittedAt" TIMESTAMP(3),
    "mevResponse" JSONB,
    "mevErrors" JSONB,
    "qrContent" TEXT,
    "mentions" JSONB,
    "relatedTransactionId" TEXT,
    "externalRef" TEXT,
    "occurredAt" TIMESTAMP(3),
    "invoicedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionItem" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "ref" TEXT,
    "description" TEXT NOT NULL,
    "quantity" TEXT NOT NULL,
    "unitPriceCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "tax" "ItemTax" NOT NULL DEFAULT 'FP',
    "activity" "ItemActivity" NOT NULL DEFAULT 'RES',
    "isModifier" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TransactionModification" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "resultTransactionId" TEXT,
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
    "reportType" "ReportType" NOT NULL DEFAULT 'RUT',
    "reportYear" INTEGER NOT NULL,
    "totalSalesCents" INTEGER NOT NULL,
    "totalTpsCents" INTEGER NOT NULL,
    "totalTvqCents" INTEGER NOT NULL,
    "totalTransactions" INTEGER NOT NULL,
    "previousYearJson" JSONB,
    "mevReportNumber" TEXT,
    "mevStatus" "MevStatus" NOT NULL DEFAULT 'PENDING',
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
    "transactionId" TEXT,
    "requestType" "MevRequestType" NOT NULL DEFAULT 'TRX',
    "status" "QueueStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfflineQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LocationMapping" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL DEFAULT 'foodhub',
    "tenantId" TEXT NOT NULL,
    "locationId" TEXT NOT NULL,
    "operatorId" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LocationMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalSale" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" "ExternalSaleKind" NOT NULL,
    "saleKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "transactionId" TEXT,
    "status" "ExternalSaleStatus" NOT NULL DEFAULT 'PROCESSING',
    "httpStatus" INTEGER,
    "responseJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalSale_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationEvent" (
    "eventId" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "bodyHash" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationEvent_pkey" PRIMARY KEY ("eventId")
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
CREATE UNIQUE INDEX "SEVUser_operatorId_externalId_key" ON "SEVUser"("operatorId", "externalId");

-- CreateIndex
CREATE INDEX "Certificate_operatorId_idx" ON "Certificate"("operatorId");

-- CreateIndex
CREATE INDEX "Certificate_deviceId_idx" ON "Certificate"("deviceId");

-- CreateIndex
CREATE INDEX "Certificate_isActive_validUntil_idx" ON "Certificate"("isActive", "validUntil");

-- CreateIndex
CREATE INDEX "Transaction_operatorId_idx" ON "Transaction"("operatorId");

-- CreateIndex
CREATE INDEX "Transaction_civilDate_idx" ON "Transaction"("civilDate");

-- CreateIndex
CREATE INDEX "Transaction_mevStatus_idx" ON "Transaction"("mevStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_deviceId_civilDate_transactionNumber_key" ON "Transaction"("deviceId", "civilDate", "transactionNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_deviceId_deviceSeq_key" ON "Transaction"("deviceId", "deviceSeq");

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
CREATE INDEX "OfflineQueue_transactionId_idx" ON "OfflineQueue"("transactionId");

-- CreateIndex
CREATE INDEX "OfflineQueue_status_idx" ON "OfflineQueue"("status");

-- CreateIndex
CREATE UNIQUE INDEX "LocationMapping_tenantId_locationId_key" ON "LocationMapping"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "ExternalSale_tenantId_saleKey_idx" ON "ExternalSale"("tenantId", "saleKey");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalSale_tenantId_key_key" ON "ExternalSale"("tenantId", "key");

-- CreateIndex
CREATE INDEX "IntegrationEvent_receivedAt_idx" ON "IntegrationEvent"("receivedAt");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SEVUser" ADD CONSTRAINT "SEVUser_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "SEVUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_relatedTransactionId_fkey" FOREIGN KEY ("relatedTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

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

-- AddForeignKey
ALTER TABLE "OfflineQueue" ADD CONSTRAINT "OfflineQueue_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationMapping" ADD CONSTRAINT "LocationMapping_operatorId_fkey" FOREIGN KEY ("operatorId") REFERENCES "Operator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LocationMapping" ADD CONSTRAINT "LocationMapping_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

