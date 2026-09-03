-- Phase 12 (revised) — flat-priced, consent-free Partner/Agency linking.
--
-- The pairing-code handshake is gone: a payer now links a companion directly
-- by its myshopify.com domain, and the companion is told after the fact via
-- a persistent dashboard banner (partnerLinkNoticeDismissedAt).
--
-- MIGRATION SAFETY: partnerLinkedTo is untouched, so every existing link is
-- preserved. Under the old model a Pro payer already included 1 companion
-- slot at a flat price and Agency's per-companion add-on plans were never
-- used in production (0 Agency shops, 1 Pro->companion link), so no pair's
-- billing changes. SQLite 3.35+ supports DROP COLUMN; the unique index on
-- pairingCode is dropped first.

-- DropIndex
DROP INDEX "ShopPlan_pairingCode_key";

-- AlterTable
ALTER TABLE "ShopPlan" DROP COLUMN "pairingCode";
ALTER TABLE "ShopPlan" DROP COLUMN "pairingCodeExpiresAt";

-- AlterTable
-- Nullable, no default: existing linked rows backfill as NULL, which shows
-- the "you've been added as a companion" banner once — acceptable and
-- accurate for links that predate this flow.
ALTER TABLE "ShopPlan" ADD COLUMN "partnerLinkNoticeDismissedAt" DATETIME;
