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
