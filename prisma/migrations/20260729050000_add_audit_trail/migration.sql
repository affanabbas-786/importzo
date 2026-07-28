-- Phase 3.7: audit trail — who triggered what, when, from which IP.
--
-- Captured on MigrationJob at trigger time because the worker is
-- fire-and-forget: by the time it writes log entries there is no request to
-- attribute them to. The worker reads these back and stamps them onto every
-- TransferLogEntry it writes.
--
-- actorEmail is personal data. Both tables are already covered by
-- shop/redact erasure (app/lib/shop-data.server.js), so no separate GDPR
-- handling is needed — enforced by the schema cross-check test.

-- AlterTable
ALTER TABLE "TransferLogEntry" ADD COLUMN "actorType" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "TransferLogEntry" ADD COLUMN "actorId" TEXT;
ALTER TABLE "TransferLogEntry" ADD COLUMN "actorEmail" TEXT;
ALTER TABLE "TransferLogEntry" ADD COLUMN "actorIp" TEXT;

-- AlterTable
ALTER TABLE "MigrationJob" ADD COLUMN "actorType" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "MigrationJob" ADD COLUMN "actorId" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN "actorEmail" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN "actorIp" TEXT;
