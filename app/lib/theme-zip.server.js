import fs from "fs/promises";
import os from "os";
import path from "path";
import crypto from "crypto";

const ZIP_DIR = path.join(os.tmpdir(), "importzo-theme-zips");

let crcTable;
function makeCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buf) {
  if (!crcTable) crcTable = makeCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function u16(n) {
  const b = Buffer.allocUnsafe(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u32(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

function safeZipName(name) {
  return String(name || "")
    .replace(/^\/+/, "")
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

export function createThemeZipBuffer(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const file of files) {
    const filename = safeZipName(file.name);
    if (!filename) continue;

    const nameBuf = Buffer.from(filename, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data || "");

    if (data.length > 0xffffffff || offset > 0xffffffff) {
      throw new Error("Theme ZIP is too large for standard ZIP format");
    }

    const crc = crc32(data);
    const localHeader = Buffer.concat([
      u32(0x04034b50), // local file header signature
      u16(20),         // version needed
      u16(0x0800),     // UTF-8 filenames
      u16(0),          // store/no compression
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
    ]);

    localParts.push(localHeader, data);

    const centralHeader = Buffer.concat([
      u32(0x02014b50), // central dir signature
      u16(20),         // version made by
      u16(20),         // version needed
      u16(0x0800),     // UTF-8 filenames
      u16(0),          // store/no compression
      u16(dosTime),
      u16(dosDate),
      u32(crc),
      u32(data.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),          // extra length
      u16(0),          // comment length
      u16(0),          // disk number start
      u16(0),          // internal attrs
      u32(0),          // external attrs
      u32(offset),
      nameBuf,
    ]);
    centralParts.push(centralHeader);

    offset += localHeader.length + data.length;
  }

  const centralStart = offset;
  const centralDir = Buffer.concat(centralParts);
  const centralSize = centralDir.length;
  const fileCount = centralParts.length;

  const end = Buffer.concat([
    u32(0x06054b50), // end of central directory
    u16(0),          // disk number
    u16(0),          // central dir disk
    u16(fileCount),
    u16(fileCount),
    u32(centralSize),
    u32(centralStart),
    u16(0),          // zip comment length
  ]);

  return Buffer.concat([...localParts, centralDir, end]);
}

export async function saveThemeZip(files) {
  await fs.mkdir(ZIP_DIR, { recursive: true });
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(24).toString("hex");
  const filename = `${id}-${token}.zip`;
  const zipPath = path.join(ZIP_DIR, filename);
  const zipBuffer = createThemeZipBuffer(files);
  await fs.writeFile(zipPath, zipBuffer);
  return { id, token, zipPath, size: zipBuffer.length };
}

export async function readThemeZip(id, token) {
  if (!/^[a-f0-9-]{36}$/i.test(String(id || ""))) return null;
  if (!/^[a-f0-9]{48}$/i.test(String(token || ""))) return null;
  const zipPath = path.join(ZIP_DIR, `${id}-${token}.zip`);
  try {
    return await fs.readFile(zipPath);
  } catch {
    return null;
  }
}

export async function deleteThemeZipLater(id, token, delayMs = 10 * 60 * 1000) {
  if (!/^[a-f0-9-]{36}$/i.test(String(id || ""))) return;
  if (!/^[a-f0-9]{48}$/i.test(String(token || ""))) return;
  const zipPath = path.join(ZIP_DIR, `${id}-${token}.zip`);
  setTimeout(() => fs.unlink(zipPath).catch(() => {}), delayMs).unref?.();
}

// ═══════════════════════════════════════════════════════════════════
// Destination theme naming.
//
// Shopify rejects a theme name over 50 characters outright:
//   HTTP 422: Name is too long (maximum is 50 characters)
// That is a hard failure of the whole theme transfer, and it was easy to
// hit — the source name is copied verbatim and a " (Transferred)" suffix
// is appended, so any source theme named beyond 36 characters failed.
// The previous cap here was 200, which only ever prevented an absurd
// payload and never the error merchants actually saw.
//
// Both the create call AND the "does this already exist?" idempotency
// check must use this same function, or a re-run stops recognising the
// theme it created last time and duplicates it instead.
// ═══════════════════════════════════════════════════════════════════

export const THEME_NAME_MAX = 50;
const TRANSFERRED_SUFFIX = " (Transferred)";

/**
 * Truncates to `max` characters, preferring the last word boundary so the
 * result reads as words rather than a word cut in half.
 *
 * The word boundary is only honoured when it keeps at least 60% of the
 * budget: for a name like "Supercalifragilistic Expialidocious Edition",
 * backing up to the previous space is a small trim, but for a single very
 * long word it would throw away nearly everything, and a mid-word cut is
 * the better of the two bad options there.
 */
export function truncateAtWord(value, max) {
  const text = String(value ?? "").trim();
  if (text.length <= max) return text;

  const hard = text.slice(0, max);
  const lastSpace = hard.lastIndexOf(" ");
  if (lastSpace >= Math.floor(max * 0.6)) return hard.slice(0, lastSpace).trim();
  return hard.trim();
}

/**
 * The name to give the copied theme on the destination store: the source
 * name plus a " (Transferred)" marker, guaranteed to fit Shopify's 50-char
 * limit. The suffix is preserved whole and the source name absorbs the
 * truncation — the marker is what tells a merchant which theme Importzo
 * created, so losing it is worse than losing a few characters of the name.
 */
export function destinationThemeName(sourceName, max = THEME_NAME_MAX) {
  const base = truncateAtWord(sourceName || "Transferred Theme", Math.max(max - TRANSFERRED_SUFFIX.length, 1));
  const full = `${base}${TRANSFERRED_SUFFIX}`;
  // Defensive: if the suffix alone exceeds `max` (only reachable with an
  // absurdly small max), fall back to a hard cut so the contract "never
  // longer than max" holds unconditionally.
  return full.length <= max ? full : full.slice(0, max);
}

// ═══════════════════════════════════════════════════════════════════
// Asset staging.
//
// The synchronous transfer accumulated every fetched asset in an
// in-memory array and built the ZIP only once all of them were held at
// once. Two problems the background job has to solve anyway:
//
//   1. Nothing survived a restart. Fetching is ~95% of a theme
//      transfer's wall time, so a crash at asset 600 of 635 repeated
//      all 635 — which would undercut most of the point of making it a
//      job at all.
//   2. Unbounded memory. One observed theme packed to 14.5 MB, but a
//      large theme with binary assets is held whole inside a process
//      that is also serving every other request.
//
// Staging writes each asset to a job-scoped directory as it arrives.
// Resume then means "list what's on disk, subtract from the manifest,
// fetch the rest" — and because the path is derived from the asset key,
// that is naturally idempotent with no index to keep in sync.
//
// tmpdir survives a PM2 restart but not a reboot or a tmp sweep. That
// is the right trade: a lost staging dir falls back to re-fetching,
// which is exactly the old behaviour, and can never produce a WRONG
// theme — a missing file is simply downloaded again.
// ═══════════════════════════════════════════════════════════════════

const STAGE_ROOT = path.join(os.tmpdir(), "importzo-theme-stage");

// Job ids are cuids, but this path is built from caller input, so it is
// validated rather than trusted — a traversal here would let a job id
// address arbitrary filesystem locations.
function safeJobId(jobId) {
  const id = String(jobId || "");
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}

export function stageDirFor(jobId) {
  const id = safeJobId(jobId);
  return id ? path.join(STAGE_ROOT, id) : null;
}

// Asset keys look like "sections/header.liquid" — a real relative path,
// which is why safeZipName's traversal stripping is reused here rather
// than trusting the key straight from Shopify.
function stagePathFor(jobId, assetKey) {
  const dir = stageDirFor(jobId);
  const rel = safeZipName(assetKey);
  if (!dir || !rel) return null;
  return path.join(dir, rel);
}

/** True when this asset has already been staged by an earlier run. */
export async function isAssetStaged(jobId, assetKey) {
  const p = stagePathFor(jobId, assetKey);
  if (!p) return false;
  try {
    const st = await fs.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

/** Writes one fetched asset into the job's staging directory. */
export async function stageAsset(jobId, assetKey, data) {
  const p = stagePathFor(jobId, assetKey);
  if (!p) throw new Error(`Refusing to stage asset with unsafe key: ${assetKey}`);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, Buffer.isBuffer(data) ? data : Buffer.from(data || ""));
  return p;
}

/**
 * Reads the staged assets back in the order the manifest lists them, as
 * the { name, data } shape createThemeZipBuffer expects.
 *
 * Driven by the manifest rather than by walking the directory, so the ZIP
 * contains exactly what the source theme has — a stray file left in the
 * staging dir can never end up inside a merchant's theme.
 */
export async function readStagedAssets(jobId, assetKeys) {
  const files = [];
  for (const key of assetKeys) {
    const p = stagePathFor(jobId, key);
    if (!p) continue;
    try {
      files.push({ name: safeZipName(key), data: await fs.readFile(p) });
    } catch {
      // Missing here means the fetch phase recorded it as failed, or tmp
      // was swept mid-job. Either way it is absent from the theme rather
      // than fatal — the layout/theme.liquid assertion is what actually
      // guards against shipping an unusable theme.
    }
  }
  return files;
}

/** Removes a job's staging directory. Safe to call more than once. */
export async function clearStagedAssets(jobId) {
  const dir = stageDirFor(jobId);
  if (!dir) return;
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Deletes a ZIP immediately, by id+token. The counterpart to
 * deleteThemeZipLater for callers that know the job is finished — a
 * worker on a terminal path should not leave a 10-minute timer that a
 * restart would discard anyway.
 */
export async function deleteThemeZipNow(id, token) {
  if (!/^[a-f0-9-]{36}$/i.test(String(id || ""))) return;
  if (!/^[a-f0-9]{48}$/i.test(String(token || ""))) return;
  await fs.unlink(path.join(ZIP_DIR, `${id}-${token}.zip`)).catch(() => {});
}

/**
 * Sweeps staging directories and ZIPs older than `maxAgeMs`.
 *
 * Needed because deleteThemeZipLater schedules an unref'd setTimeout that
 * a process restart silently discards — every killed transfer used to
 * leak its ZIP into tmp forever. Called from the scheduler tick, which is
 * the app's only periodic server-side hook.
 */
export async function sweepThemeTempFiles({ maxAgeMs = 6 * 60 * 60 * 1000, now = Date.now() } = {}) {
  const removed = { stageDirs: 0, zips: 0 };

  for (const [root, key] of [[STAGE_ROOT, "stageDirs"], [ZIP_DIR, "zips"]]) {
    let entries;
    try {
      entries = await fs.readdir(root);
    } catch {
      continue; // directory has never been created — nothing to sweep
    }
    for (const entry of entries) {
      const full = path.join(root, entry);
      try {
        const st = await fs.stat(full);
        if (now - st.mtimeMs < maxAgeMs) continue;
        await fs.rm(full, { recursive: true, force: true });
        removed[key] += 1;
      } catch { /* raced with another sweep, or unreadable — skip */ }
    }
  }

  return removed;
}
