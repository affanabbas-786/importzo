-- CreateTable
CREATE TABLE "ShopPlan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'free',
    "shopOwnerEmail" TEXT,
    "recordsUsed" INTEGER NOT NULL DEFAULT 0,
    "usagePeriodStart" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "subscriptionId" TEXT,
    "subscriptionStatus" TEXT,
    "uninstalledAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopPlan_shop_key" ON "ShopPlan"("shop");

-- CreateIndex
CREATE INDEX "ShopPlan_shopOwnerEmail_idx" ON "ShopPlan"("shopOwnerEmail");
