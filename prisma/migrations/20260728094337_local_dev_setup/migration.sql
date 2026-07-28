-- CreateTable
CREATE TABLE "TransferSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "sourceShop" TEXT NOT NULL,
    "sourceToken" TEXT NOT NULL,
    "destShop" TEXT,
    "destToken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MigrationJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "sourceShop" TEXT NOT NULL,
    "sourceToken" TEXT NOT NULL,
    "destToken" TEXT NOT NULL,
    "apiVersion" TEXT NOT NULL DEFAULT '2025-10',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "processedProducts" INTEGER NOT NULL DEFAULT 0,
    "failedProducts" INTEGER NOT NULL DEFAULT 0,
    "lastCursor" TEXT,
    "conflictMode" TEXT NOT NULL DEFAULT 'skip',
    "errorLog" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProductMapping" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "sourceProductId" TEXT NOT NULL,
    "destProductId" TEXT,
    "status" TEXT NOT NULL,
    "error" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "TransferSession_code_key" ON "TransferSession"("code");

-- CreateIndex
CREATE INDEX "ProductMapping_jobId_idx" ON "ProductMapping"("jobId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductMapping_jobId_sourceProductId_key" ON "ProductMapping"("jobId", "sourceProductId");
