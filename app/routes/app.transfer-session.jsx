// app/routes/app.transfer-session.jsx
// Secure Transfer Session pairing API.
// Source store creates a session (code + hashed password).
// Destination store joins using the code + password.
// Server resolves both tokens from DB — tokens never travel to the client.

import crypto from "crypto";
import bcrypt from "bcryptjs";
import { authenticate, apiVersion } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import prisma from "../db.server";
import { encrypt, decrypt } from "../utils/encryption.server";
import { upsertSourceStore } from "../lib/safe-db";

// ── Helpers ────────────────────────────────────────────────────────────────

// Unambiguous uppercase alphanumeric chars: no 0/O, no 1/I/L
const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 chars

function generateSessionCode() {
  // Reject bytes that would introduce modulo bias (256 % 31 = 8 → reject ≥ 248)
  const bytes = crypto.randomBytes(32);
  let code = "";
  for (let i = 0; i < bytes.length && code.length < 6; i++) {
    if (bytes[i] < 248) {
      code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    }
  }
  // Safety: extremely unlikely, but pad if needed
  while (code.length < 6) {
    const b = crypto.randomBytes(1)[0];
    if (b < 248) code += CODE_CHARS[b % CODE_CHARS.length];
  }
  return code;
}

// Ensure the TransferSession table exists (safety net for un-migrated envs)
let _tsTableEnsured = false;
async function ensureTransferSessionTable() {
  if (_tsTableEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "TransferSession" (
        "id"           TEXT    NOT NULL PRIMARY KEY,
        "code"         TEXT    NOT NULL UNIQUE,
        "password"     TEXT    NOT NULL,
        "sourceShop"   TEXT    NOT NULL,
        "sourceToken"  TEXT    NOT NULL,
        "destShop"     TEXT,
        "destToken"    TEXT,
        "status"       TEXT    NOT NULL DEFAULT 'pending',
        "attemptCount" INTEGER NOT NULL DEFAULT 0,
        "expiresAt"    DATETIME NOT NULL,
        "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
    _tsTableEnsured = true;
  } catch (err) {
    console.warn("[importzo] ensureTransferSessionTable:", err?.message);
  }
}

function hasTransferSessionModel() {
  return !!(prisma?.transferSession?.findUnique);
}

// ── Action ─────────────────────────────────────────────────────────────────

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");
  const currentShop = session.shop;
  const currentToken = session.accessToken;
  const version = apiVersion || "2025-10";

  await ensureTransferSessionTable();

  // ── create-session (source store) ─────────────────────────────────────────
  if (intent === "create-session") {
    const password = (formData.get("password") || "").trim();
    if (!password || password.length < 4) {
      return { intent, ok: false, error: "Password must be at least 4 characters" };
    }

    try {
      // Clean up any stale pending sessions from this source shop
      if (hasTransferSessionModel()) {
        await prisma.transferSession.deleteMany({
          where: { sourceShop: currentShop, status: "pending" },
        });
      }

      const code = generateSessionCode();
      const hashedPassword = await bcrypt.hash(password, 10);
      const encryptedToken = encrypt(currentToken);
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

      let ts;
      if (hasTransferSessionModel()) {
        ts = await prisma.transferSession.create({
          data: {
            code,
            password: hashedPassword,
            sourceShop: currentShop,
            sourceToken: encryptedToken,
            status: "pending",
            attemptCount: 0,
            expiresAt,
          },
        });
      } else {
        return { intent, ok: false, error: "Session table not available — run migrations" };
      }

      return {
        intent,
        ok: true,
        sessionId: ts.id,
        code,
        expiresAt: expiresAt.toISOString(),
      };
    } catch (err) {
      console.error("[importzo] create-session error:", err?.message);
      return { intent, ok: false, error: "Failed to create session. Please try again." };
    }
  }

  // ── join-session (destination store) ──────────────────────────────────────
  if (intent === "join-session") {
    const code = (formData.get("code") || "").trim().toUpperCase();
    const password = formData.get("password") || "";

    if (!code || !password) {
      return { intent, ok: false, error: "Please enter the session code and password" };
    }

    if (!hasTransferSessionModel()) {
      return { intent, ok: false, error: "Session service unavailable — run migrations" };
    }

    try {
      const ts = await prisma.transferSession.findUnique({ where: { code } });

      if (!ts || ts.status !== "pending" || new Date() > new Date(ts.expiresAt)) {
        return { intent, ok: false, error: "Invalid or expired session code" };
      }

      // Brute-force protection: max 5 attempts before auto-revoke
      if (ts.attemptCount >= 5) {
        await prisma.transferSession.delete({ where: { id: ts.id } }).catch(() => {});
        return {
          intent,
          ok: false,
          error: "Too many failed attempts. This session has been revoked. Ask the source store to generate a new code.",
        };
      }

      // Same-store guard
      if (ts.sourceShop === currentShop) {
        return { intent, ok: false, error: "Cannot transfer to the same store" };
      }

      // Verify password
      const passwordMatch = await bcrypt.compare(password, ts.password);
      if (!passwordMatch) {
        await prisma.transferSession.update({
          where: { id: ts.id },
          data: { attemptCount: { increment: 1 } },
        });
        const remaining = Math.max(0, 4 - ts.attemptCount);
        return {
          intent,
          ok: false,
          error: `Incorrect password. ${remaining} attempt${remaining !== 1 ? "s" : ""} remaining.`,
        };
      }

      // Decrypt source token and verify the source store is reachable
      const sourceToken = decrypt(ts.sourceToken);
      const sourceShop = ts.sourceShop;
      let shopName, shopEmail, shopPlan;
      let productCount = 0, collectionCount = 0, themeCount = 0, themes = [];

      try {
        // GraphQL: shop info + counts in one request
        const gqlRes = await fetch(`https://${sourceShop}/admin/api/${version}/graphql.json`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": sourceToken },
          body: JSON.stringify({ query: `{ shop { name email plan { displayName } } productsCount { count } collectionsCount { count } }` }),
        });
        if (gqlRes.status === 401 || gqlRes.status === 403) {
          throw new Error("Could not verify source store: invalid token. The source store owner may need to reinstall Importzo.");
        }
        if (!gqlRes.ok) {
          throw new Error(`Could not verify source store (HTTP ${gqlRes.status}). The source store owner may need to reinstall Importzo.`);
        }
        const gqlData = await gqlRes.json();
        shopName = gqlData?.data?.shop?.name || sourceShop;
        shopEmail = gqlData?.data?.shop?.email || "";
        shopPlan = gqlData?.data?.shop?.plan?.displayName || "";
        productCount = gqlData?.data?.productsCount?.count || 0;
        collectionCount = gqlData?.data?.collectionsCount?.count || 0;

        // Themes: REST (Theme API exempt from GraphQL migration)
        const tc = await fetch(`https://${sourceShop}/admin/api/${version}/themes.json`, { headers: { "X-Shopify-Access-Token": sourceToken } });
        if (tc.ok) { const td = await tc.json(); themes = td.themes || []; themeCount = themes.length; }
      } catch (err) {
        return { intent, ok: false, error: err.message };
      }

      // Persist source store to DB so existing transfer logic finds it normally
      await upsertSourceStore(currentShop, {
        sourceUrl: sourceShop,
        sourceName: shopName,
        sourceEmail: shopEmail,
        sourcePlan: shopPlan,
        token: sourceToken,
      });

      // Mark session active; extend expiry to 4 h to cover the transfer itself
      const extendedExpiry = new Date(Date.now() + 4 * 60 * 60 * 1000);
      await prisma.transferSession.update({
        where: { id: ts.id },
        data: {
          destShop: currentShop,
          destToken: encrypt(currentToken),
          status: "active",
          expiresAt: extendedExpiry,
        },
      });

      return {
        intent,
        ok: true,
        sessionId: ts.id,
        sourceShop,
        shopName,
        shopEmail,
        shopPlan,
        shopDomain: sourceShop,
        productCount,
        collectionCount,
        themeCount,
        themes,
      };
    } catch (err) {
      console.error("[importzo] join-session error:", err?.message);
      return { intent, ok: false, error: "Session join failed. Please try again." };
    }
  }

  // ── get-session ────────────────────────────────────────────────────────────
  if (intent === "get-session") {
    const sessionId = (formData.get("sessionId") || "").trim();
    if (!sessionId || !hasTransferSessionModel()) {
      return { intent, ok: false, error: "Session not found" };
    }
    try {
      const ts = await prisma.transferSession.findUnique({ where: { id: sessionId } });
      if (!ts) return { intent, ok: false, error: "Session not found" };
      if (new Date() > new Date(ts.expiresAt)) {
        await prisma.transferSession.delete({ where: { id: ts.id } }).catch(() => {});
        return { intent, ok: false, error: "Session expired" };
      }
      return { intent, ok: true, sourceShop: ts.sourceShop, destShop: ts.destShop, status: ts.status };
    } catch (err) {
      return { intent, ok: false, error: "Could not retrieve session" };
    }
  }

  // ── cancel-session ─────────────────────────────────────────────────────────
  if (intent === "cancel-session") {
    const sessionId = (formData.get("sessionId") || "").trim();
    if (sessionId && hasTransferSessionModel()) {
      try {
        await prisma.transferSession.deleteMany({ where: { id: sessionId } });
      } catch (_) { /* non-fatal */ }
    }
    return { intent, ok: true };
  }

  return { intent, ok: false, error: "Unknown intent" };
};

// This route is action-only — accessed via useFetcher from app.transfer
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return {};
};

export default function TransferSessionPage() {
  return null;
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
