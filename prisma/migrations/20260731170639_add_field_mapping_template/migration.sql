-- CreateTable
CREATE TABLE "FieldMappingTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "importType" TEXT NOT NULL,
    "mapping" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "FieldMappingTemplate_shop_importType_idx" ON "FieldMappingTemplate"("shop", "importType");

-- CreateIndex
CREATE UNIQUE INDEX "FieldMappingTemplate_shop_importType_name_key" ON "FieldMappingTemplate"("shop", "importType", "name");
