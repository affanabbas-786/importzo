-- AlterTable
ALTER TABLE "MigrationJob" ADD COLUMN "sourceMarketHandle" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN "sourceMarketId" TEXT;
ALTER TABLE "MigrationJob" ADD COLUMN "sourceMarketPublicationIds" TEXT;
