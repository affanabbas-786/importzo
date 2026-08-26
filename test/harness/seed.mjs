// Creates ThemeJob rows directly against the harness DB.
import { APP_DIR, DB_URL, ENCRYPTION_KEY, TMP_DIR } from "./lib.mjs";

process.env.NODE_ENV ||= "test";
process.env.DATABASE_URL = DB_URL;
process.env.ENCRYPTION_KEY = ENCRYPTION_KEY;
process.env.TMPDIR = TMP_DIR;

const { default: prisma } = await import(`${APP_DIR}/app/db.server.js`);
const { encrypt } = await import(`${APP_DIR}/app/utils/encryption.server.js`);

export { prisma };

export async function createThemeJob({
  id, shop, sourceShop, sourceThemeId = "111",
  sourceThemeName = "Dawn", targetThemeName = "Dawn (from source)",
  phase = "LISTING", status = "PENDING", ...rest
}) {
  return prisma.themeJob.create({
    data: {
      id, shop, sourceShop, sourceThemeId, sourceThemeName, targetThemeName,
      sourceToken: encrypt("shpat_source"), destToken: encrypt("shpat_dest"),
      apiVersion: "2026-04", status, phase, ...rest,
    },
  });
}

export const readJob = (id) => prisma.themeJob.findUnique({ where: { id } });
export const resetJobs = () => prisma.themeJob.deleteMany({});
