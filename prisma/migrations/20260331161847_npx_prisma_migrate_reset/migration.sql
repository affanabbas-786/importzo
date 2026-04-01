-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ImportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "totalRows" INTEGER NOT NULL,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "results" TEXT NOT NULL DEFAULT '[]',
    "importType" TEXT NOT NULL DEFAULT 'products',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_ImportJob" ("createdAt", "errorCount", "fileName", "id", "results", "shop", "status", "successCount", "totalRows") SELECT "createdAt", "errorCount", "fileName", "id", "results", "shop", "status", "successCount", "totalRows" FROM "ImportJob";
DROP TABLE "ImportJob";
ALTER TABLE "new_ImportJob" RENAME TO "ImportJob";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
