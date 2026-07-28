-- Phase 2 (rollback safety): record what the transfer actually did to each
-- destination product. Rollback may only delete rows it can prove this app
-- created. Existing rows default to 'unknown' — written before this column
-- existed, so we cannot prove we created them and must never delete them.
-- AlterTable
ALTER TABLE "ProductMapping" ADD COLUMN "action" TEXT NOT NULL DEFAULT 'unknown';

-- CreateIndex
CREATE INDEX IF NOT EXISTS "ProductMapping_jobId_action_idx" ON "ProductMapping"("jobId", "action");
