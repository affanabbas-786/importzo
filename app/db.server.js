import { PrismaClient } from "@prisma/client";

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

// WAL mode: allows concurrent reads (status polling) while the worker writes.
prisma.$executeRawUnsafe("PRAGMA journal_mode=WAL;").catch(() => {});

export default prisma;
