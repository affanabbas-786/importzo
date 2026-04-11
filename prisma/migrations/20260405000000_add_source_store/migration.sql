-- CreateTable
CREATE TABLE IF NOT EXISTS "SourceStore" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "sourceName" TEXT NOT NULL DEFAULT '',
    "sourceEmail" TEXT NOT NULL DEFAULT '',
    "sourcePlan" TEXT NOT NULL DEFAULT '',
    "token" TEXT NOT NULL,
    "lastUsed" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "SourceStore_shop_key" ON "SourceStore"("shop");
