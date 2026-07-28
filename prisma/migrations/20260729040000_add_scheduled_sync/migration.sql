-- Phase 2: recurring/scheduled sync configuration.
-- CreateTable
CREATE TABLE IF NOT EXISTS "ScheduledSync" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "sourceShop" TEXT NOT NULL,
    "sourceToken" TEXT NOT NULL,
    "destToken" TEXT NOT NULL,
    "frequency" TEXT NOT NULL DEFAULT 'daily',
    "hourUtc" INTEGER NOT NULL DEFAULT 3,
    "dayOfWeek" INTEGER,
    "conflictMode" TEXT NOT NULL DEFAULT 'skip',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" DATETIME NOT NULL,
    "lastRunAt" DATETIME,
    "lastJobId" TEXT,
    "lastError" TEXT,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledReason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ScheduledSync_enabled_nextRunAt_idx" ON "ScheduledSync"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ScheduledSync_shop_idx" ON "ScheduledSync"("shop");
