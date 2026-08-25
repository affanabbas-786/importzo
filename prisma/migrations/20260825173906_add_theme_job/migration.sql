-- CreateTable
CREATE TABLE "ThemeJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "sourceShop" TEXT NOT NULL,
    "sourceThemeId" TEXT NOT NULL,
    "sourceThemeName" TEXT NOT NULL,
    "targetThemeName" TEXT NOT NULL,
    "sourceToken" TEXT NOT NULL,
    "destToken" TEXT NOT NULL,
    "apiVersion" TEXT NOT NULL DEFAULT '2025-10',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "phase" TEXT NOT NULL DEFAULT 'LISTING',
    "assetsTotal" INTEGER NOT NULL DEFAULT 0,
    "assetsFetched" INTEGER NOT NULL DEFAULT 0,
    "assetsFailed" INTEGER NOT NULL DEFAULT 0,
    "newThemeId" TEXT,
    "zipId" TEXT,
    "zipToken" TEXT,
    "errorLog" TEXT NOT NULL DEFAULT '[]',
    "actorType" TEXT NOT NULL DEFAULT 'unknown',
    "actorId" TEXT,
    "actorEmail" TEXT,
    "actorIp" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "ThemeJob_shop_status_idx" ON "ThemeJob"("shop", "status");
