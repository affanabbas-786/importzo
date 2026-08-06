import { PrismaClient } from "@prisma/client";
import { assertDatabaseMatchesEnv } from "./lib/database-guard.js";

// Before any client is constructed, and here rather than in shopify.server.js
// so it covers every entry point that touches the database — the migration
// worker, the scheduler tick, one-off scripts — not just the web app.
assertDatabaseMatchesEnv({
  nodeEnv: process.env.NODE_ENV,
  databaseUrl: process.env.DATABASE_URL,
});

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

// WAL mode: allows concurrent reads (status polling) while the worker writes.
prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL;").catch(() => {});

export default prisma;
