// ═══════════════════════════════════════════════════════════════════
// Phase 5 — Billing: monthly usage tracking and enforcement.
//
// One ShopPlan row per shop (lazily created — see getOrCreateShopPlan).
// "Records this month" resets on true calendar-month boundaries (UTC), not
// a rolling window anchored to install date, matching the product wording
// ("records this month") literally and keeping the reset predictable
// regardless of when a shop installed. Free has no Shopify subscription to
// anchor a cycle to anyway.
//
// Per product decision: EVERY successful create/update any import or
// transfer path performs counts as one record (products, collections,
// inventory rows, pages, blogs, articles, menus, files, themes). Skipped or
// failed rows never count — see recordUsageAndCheck below, and every
// write-path call site, which only calls it after a row actually succeeds.
// ═══════════════════════════════════════════════════════════════════

import { getPlan, PLAN_IDS, AI_MONTHLY_CALL_CAP, builtInAiAllowed } from "./plans.js";

function currentPeriodStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

function samePeriod(a, b) {
  const da = new Date(a);
  const db = new Date(b);
  return da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth();
}

function toStatus(row) {
  const plan = getPlan(row.tier);
  const limit = plan.recordLimit;
  const unlimited = limit === Infinity;
  return {
    shop: row.shop,
    tier: row.tier,
    label: plan.label,
    limit: unlimited ? null : limit,
    used: row.recordsUsed,
    remaining: unlimited ? null : Math.max(0, limit - row.recordsUsed),
    isUnlimited: unlimited,
    periodStart: row.usagePeriodStart,
    scheduledSyncAllowed: !!plan.scheduledSync,
    subscriptionId: row.subscriptionId || null,
    subscriptionStatus: row.subscriptionStatus || null,
    // Phase 8 — on Agency pricing without meeting the 3-store requirement.
    // Carried on the usage status (rather than recomputed) so Settings and
    // any other page already loading usage can surface the notice for free;
    // establishing it needs a Shopify round trip, and only app.billing.jsx
    // pays that cost. See syncAgencyIneligibilityFlag.
    agencyIneligibleSince: row.agencyIneligibleSince || null,
    // Phase 12 — the payer's shop domain, if this shop is a linked companion.
    // See partner-linking.server.js.
    partnerLinkedTo: row.partnerLinkedTo || null,
    // When this companion dismissed the "you were added" dashboard banner
    // (null while unacknowledged, so the banner still shows).
    partnerLinkNoticeDismissedAt: row.partnerLinkNoticeDismissedAt || null,
  };
}

/**
 * Fetches this shop's plan row, creating a Free-tier default on first
 * access. `upsert` (rather than findUnique-then-create) so two concurrent
 * requests racing to create the same shop's first row can't throw a unique
 * constraint error into an unrelated caller.
 */
export async function getOrCreateShopPlan({ prisma, shop, now = new Date() }) {
  return prisma.shopPlan.upsert({
    where: { shop },
    update: {},
    create: {
      shop, tier: PLAN_IDS.FREE,
      usagePeriodStart: currentPeriodStart(now),
      // Set explicitly (like usagePeriodStart above) rather than relying on
      // the schema's @default(now()) — app code reasons about "is this the
      // same month as `now`" immediately after creation, so it needs to be
      // pinned to the same clock the caller is using, not the DB's.
      aiUsagePeriodStart: currentPeriodStart(now),
    },
  });
}

// Resets recordsUsed to 0 when the stored period has rolled into a new
// calendar month. Internal — callers go through getUsageStatus/recordUsage,
// both of which apply this before reading or writing recordsUsed.
async function applyRolloverIfNeeded({ prisma, row, now }) {
  if (samePeriod(row.usagePeriodStart, now)) return row;
  return prisma.shopPlan.update({
    where: { shop: row.shop },
    data: { recordsUsed: 0, usagePeriodStart: currentPeriodStart(now) },
  });
}

/** Current plan + usage snapshot for a shop. Never mutates usage counts. */
export async function getUsageStatus({ prisma, shop, now = new Date() }) {
  let row = await getOrCreateShopPlan({ prisma, shop, now });
  row = await applyRolloverIfNeeded({ prisma, row, now });
  return toStatus(row);
}

/**
 * Call once before a job/batch of writes starts. Returns { ok: true,
 * status } when the shop may proceed, or { ok: false, status, message }
 * when a capped plan has already used its full monthly allowance — the
 * caller should refuse to start rather than open a job that can write zero
 * records. Unlimited plans (Pro/Agency) always pass.
 */
export async function assertQuotaAvailable({ prisma, shop, now = new Date() }) {
  const status = await getUsageStatus({ prisma, shop, now });
  if (status.isUnlimited || status.remaining > 0) return { ok: true, status };
  return {
    ok: false,
    status,
    message: `You've used all ${status.limit} records included in your ${status.label} plan this month. Upgrade to Pro for unlimited records — $${getPlan(PLAN_IDS.PRO).price}/month or $${getPlan(PLAN_IDS.PRO).priceYearly}/year — or wait for your usage to reset.`,
  };
}

/**
 * Call after EACH successful create/update — never for a skipped or failed
 * row (only successes consume quota, by product decision). Increments
 * recordsUsed by `count` and reports whether the shop has now reached its
 * cap, so an in-progress loop knows to stop writing further records instead
 * of quietly running past the plan's limit.
 *
 * Always increments, even on unlimited plans — usage is still tracked for
 * display ("records this month") regardless of whether it's enforced.
 */
export async function recordUsageAndCheck({ prisma, shop, count = 1, now = new Date() }) {
  if (!Number.isFinite(count) || count <= 0) {
    return { status: await getUsageStatus({ prisma, shop, now }), limitReached: false };
  }

  const row = await getOrCreateShopPlan({ prisma, shop, now });
  await applyRolloverIfNeeded({ prisma, row, now });
  const updated = await prisma.shopPlan.update({
    where: { shop },
    data: { recordsUsed: { increment: count } },
  });

  const status = toStatus(updated);
  return { status, limitReached: !status.isUnlimited && status.remaining <= 0 };
}

// ═══════════════════════════════════════════════════════════════════
// Built-in AI (Groq) usage — a second, independent counter on the same
// ShopPlan row. Deliberately separate from recordsUsed/usagePeriodStart
// above: records quota is "how much data you moved," AI quota is "how
// many built-in-AI calls you made" — different limits, different meaning,
// and a shop can exhaust one without touching the other. Shared across
// every built-in-AI feature (SEO cleanup, alt-text, duplicate detection,
// error diagnosis) via one counter, per product decision — see
// AI_MONTHLY_CALL_CAP in plans.js. Bring-your-own-key calls never reach
// these functions at all; only a call actually billed to Importzo's own
// Groq key does.
// ═══════════════════════════════════════════════════════════════════

function toAiStatus(row) {
  const allowed = builtInAiAllowed(row.tier);
  const used = row.aiCallsUsed;
  return {
    tier: row.tier,
    label: getPlan(row.tier).label,
    allowed,
    limit: AI_MONTHLY_CALL_CAP,
    used,
    remaining: Math.max(0, AI_MONTHLY_CALL_CAP - used),
    periodStart: row.aiUsagePeriodStart,
  };
}

// Resets aiCallsUsed to 0 when the stored AI period has rolled into a new
// calendar month. Independent of applyRolloverIfNeeded above — a shop's
// records period and AI period can be in step or not; each rolls over on
// its own read/write, not in lockstep.
async function applyAiRolloverIfNeeded({ prisma, row, now }) {
  if (samePeriod(row.aiUsagePeriodStart, now)) return row;
  return prisma.shopPlan.update({
    where: { shop: row.shop },
    data: { aiCallsUsed: 0, aiUsagePeriodStart: currentPeriodStart(now) },
  });
}

/** Current built-in-AI plan-eligibility + usage snapshot. Never mutates. */
export async function getAiUsageStatus({ prisma, shop, now = new Date() }) {
  let row = await getOrCreateShopPlan({ prisma, shop, now });
  row = await applyAiRolloverIfNeeded({ prisma, row, now });
  return toAiStatus(row);
}

/**
 * Call before any built-in-AI (Groq) call. Returns { ok: true, status }
 * when the shop may proceed, or { ok: false, status, message } when
 * either the plan doesn't include built-in AI at all, or this month's
 * shared 500-call budget is used up. The message always points at BYOK as
 * a fallback — a merchant hitting either limit can keep working
 * immediately by connecting their own key, rather than being stuck.
 */
export async function assertAiQuotaAvailable({ prisma, shop, now = new Date() }) {
  const status = await getAiUsageStatus({ prisma, shop, now });
  if (!status.allowed) {
    return {
      ok: false,
      status,
      message: `Importzo's built-in AI requires the Pro or Agency plan. You're currently on the ${status.label} plan — you can still use it by connecting your own Anthropic or OpenAI key in Settings.`,
    };
  }
  if (status.remaining <= 0) {
    return {
      ok: false,
      status,
      message: `You've used all ${status.limit} built-in AI suggestions included this month. Connect your own Anthropic or OpenAI key in Settings to keep going, or wait for next month's reset.`,
    };
  }
  return { ok: true, status };
}

/**
 * Call after each successful built-in-AI (Groq) call — never for a BYOK
 * call, and never speculatively before the call succeeds. Mirrors
 * recordUsageAndCheck's shape/semantics for the records counter.
 */
export async function recordAiUsage({ prisma, shop, count = 1, now = new Date() }) {
  if (!Number.isFinite(count) || count <= 0) {
    return { status: await getAiUsageStatus({ prisma, shop, now }), limitReached: false };
  }

  const row = await getOrCreateShopPlan({ prisma, shop, now });
  await applyAiRolloverIfNeeded({ prisma, row, now });
  const updated = await prisma.shopPlan.update({
    where: { shop },
    data: { aiCallsUsed: { increment: count } },
  });

  const status = toAiStatus(updated);
  return { status, limitReached: status.remaining <= 0 };
}

/**
 * Sets the plan tier directly (no usage reset) — used when reconciling
 * against Shopify's actual AppSubscription state (see app.billing.jsx) and
 * when a shop downgrades to Free after cancelling. Usage counters are left
 * alone: switching plans mid-month shouldn't reset "records this month",
 * only the limit that applies to it.
 */
export async function setShopTier({ prisma, shop, tier, subscriptionId = null, subscriptionStatus = null, now = new Date() }) {
  await getOrCreateShopPlan({ prisma, shop, now });
  const updated = await prisma.shopPlan.update({
    where: { shop },
    data: { tier, subscriptionId, subscriptionStatus },
  });
  return toStatus(updated);
}
