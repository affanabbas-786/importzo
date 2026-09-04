-- Phase 12 — Partner/Agency linking. A payer store funds Pro-equivalent
-- access on partner stores it manages through its own subscription; the
-- partner never touches Shopify Billing. See partner-linking.server.js.
-- Nullable, no default: existing rows backfill as NULL, the correct
-- "not linked" state.
-- AlterTable
ALTER TABLE "ShopPlan" ADD COLUMN "partnerLinkedTo" TEXT;
ALTER TABLE "ShopPlan" ADD COLUMN "pairingCode" TEXT;
ALTER TABLE "ShopPlan" ADD COLUMN "pairingCodeExpiresAt" DATETIME;

-- CreateIndex
CREATE UNIQUE INDEX "ShopPlan_pairingCode_key" ON "ShopPlan"("pairingCode");

-- CreateIndex
CREATE INDEX "ShopPlan_partnerLinkedTo_idx" ON "ShopPlan"("partnerLinkedTo");
