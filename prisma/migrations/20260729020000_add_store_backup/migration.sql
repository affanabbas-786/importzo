-- Phase 2: pre-transfer snapshot of the destination store, for one-click undo.
-- CreateTable
CREATE TABLE IF NOT EXISTS "StoreBackup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "jobId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "productCount" INTEGER NOT NULL DEFAULT 0,
    "collectionCount" INTEGER NOT NULL DEFAULT 0,
    "metafieldCount" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "data" TEXT NOT NULL DEFAULT '{}',
    "sizeBytes" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "restoredAt" DATETIME
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StoreBackup_shop_idx" ON "StoreBackup"("shop");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StoreBackup_jobId_idx" ON "StoreBackup"("jobId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "StoreBackup_shop_createdAt_idx" ON "StoreBackup"("shop", "createdAt");

-- Phase 2: link a migration job to its pre-transfer backup.
-- AlterTable (SQLite: ADD COLUMN is safe/additive; guarded for re-runs)
ALTER TABLE "MigrationJob" ADD COLUMN "backupPolicy" TEXT NOT NULL DEFAULT 'require';
ALTER TABLE "MigrationJob" ADD COLUMN "backupId" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN "backupStatus" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN "rolledBackAt" DATETIME;
