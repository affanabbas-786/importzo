-- Phase 8 — Shopify App Pricing. Shopify's hosted plan-selection page cannot
-- enforce Importzo's 3-store Agency requirement, so a shop can hold an Agency
-- subscription without qualifying. Nullable and with no default: existing rows
-- backfill as NULL, which is the correct "not flagged" state.
-- AlterTable
ALTER TABLE "ShopPlan" ADD COLUMN "agencyIneligibleSince" DATETIME;
