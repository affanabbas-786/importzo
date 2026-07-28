-- Phase 2: granular per-record transfer log (all entity types, not just products).
-- CreateTable
CREATE TABLE IF NOT EXISTS "TransferLogEntry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "sourceId" TEXT,
    "destId" TEXT,
    "title" TEXT,
    "reason" TEXT,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TransferLogEntry_jobId_idx" ON "TransferLogEntry"("jobId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TransferLogEntry_jobId_action_idx" ON "TransferLogEntry"("jobId", "action");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "TransferLogEntry_jobId_entityType_idx" ON "TransferLogEntry"("jobId", "entityType");
