import { describe, it, expect, vi } from "vitest";
import {
  getOrCreateShopPlan, getUsageStatus, assertQuotaAvailable, recordUsageAndCheck, setShopTier,
  getAiUsageStatus, assertAiQuotaAvailable, recordAiUsage,
} from "./usage.server.js";
import { PLAN_IDS, AI_MONTHLY_CALL_CAP } from "./plans.js";

function fakePrisma() {
  const rows = new Map();
  return {
    shopPlan: {
      upsert: vi.fn(async ({ where: { shop }, update, create }) => {
        const existing = rows.get(shop);
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = {
          id: `plan-${rows.size + 1}`, shop, recordsUsed: 0, subscriptionId: null,
          subscriptionStatus: null, shopOwnerEmail: null, uninstalledAt: null,
          aiCallsUsed: 0, aiUsagePeriodStart: new Date(),
          createdAt: new Date(), updatedAt: new Date(), ...create,
        };
        rows.set(shop, row);
        return row;
      }),
      findUnique: vi.fn(async ({ where: { shop } }) => rows.get(shop) || null),
      update: vi.fn(async ({ where: { shop }, data }) => {
        const row = rows.get(shop);
        if (!row) throw new Error("Record to update not found.");
        const patch = { ...data };
        if (patch.recordsUsed && typeof patch.recordsUsed === "object" && "increment" in patch.recordsUsed) {
          patch.recordsUsed = row.recordsUsed + patch.recordsUsed.increment;
        }
        if (patch.aiCallsUsed && typeof patch.aiCallsUsed === "object" && "increment" in patch.aiCallsUsed) {
          patch.aiCallsUsed = row.aiCallsUsed + patch.aiCallsUsed.increment;
        }
        Object.assign(row, patch, { updatedAt: new Date() });
        return row;
      }),
    },
    __rows: rows,
  };
}

const SHOP = "dest-shop.myshopify.com";
const AUG_1 = new Date(Date.UTC(2026, 7, 1, 0, 0, 0));
const AUG_15 = new Date(Date.UTC(2026, 7, 15, 12, 0, 0));
const SEP_2 = new Date(Date.UTC(2026, 8, 2, 0, 0, 0));

describe("getOrCreateShopPlan", () => {
  it("lazily creates a Free-tier row with the current calendar month as the period start", async () => {
    const prisma = fakePrisma();
    const row = await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    expect(row.tier).toBe(PLAN_IDS.FREE);
    expect(row.recordsUsed).toBe(0);
    expect(row.usagePeriodStart).toEqual(AUG_1);
  });

  it("returns the existing row unchanged on a second call (race-safe upsert)", async () => {
    const prisma = fakePrisma();
    const first = await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await prisma.shopPlan.update({ where: { shop: SHOP }, data: { tier: PLAN_IDS.PRO } });
    const second = await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    expect(second.id).toBe(first.id);
    expect(second.tier).toBe(PLAN_IDS.PRO); // proves it wasn't recreated
  });
});

describe("getUsageStatus", () => {
  it("reports a fresh Free shop as 0/250 with 250 remaining", async () => {
    const prisma = fakePrisma();
    const status = await getUsageStatus({ prisma, shop: SHOP, now: AUG_15 });
    expect(status).toMatchObject({ tier: PLAN_IDS.FREE, limit: 250, used: 0, remaining: 250, isUnlimited: false });
  });

  it("reports Pro/Agency as unlimited with a null limit/remaining", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.PRO, now: AUG_15 });
    const status = await getUsageStatus({ prisma, shop: SHOP, now: AUG_15 });
    expect(status.isUnlimited).toBe(true);
    expect(status.limit).toBeNull();
    expect(status.remaining).toBeNull();
    expect(status.scheduledSyncAllowed).toBe(true);
  });

  it("rolls usage over to 0 when the calendar month has advanced, without a caller having to call anything special", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await prisma.shopPlan.update({ where: { shop: SHOP }, data: { recordsUsed: 200 } });

    const augStatus = await getUsageStatus({ prisma, shop: SHOP, now: AUG_15 });
    expect(augStatus.used).toBe(200);

    const sepStatus = await getUsageStatus({ prisma, shop: SHOP, now: SEP_2 });
    expect(sepStatus.used).toBe(0);
    expect(sepStatus.remaining).toBe(250);
    expect(sepStatus.periodStart).toEqual(new Date(Date.UTC(2026, 8, 1)));
  });

  it("does not roll over usage within the same calendar month", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_1 });
    await prisma.shopPlan.update({ where: { shop: SHOP }, data: { recordsUsed: 40 } });
    const status = await getUsageStatus({ prisma, shop: SHOP, now: AUG_15 });
    expect(status.used).toBe(40);
  });
});

describe("assertQuotaAvailable", () => {
  it("allows a Free shop with remaining quota to proceed", async () => {
    const prisma = fakePrisma();
    const result = await assertQuotaAvailable({ prisma, shop: SHOP, now: AUG_15 });
    expect(result.ok).toBe(true);
  });

  it("refuses a Free shop that has used its full monthly allowance, with an explanatory message", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await prisma.shopPlan.update({ where: { shop: SHOP }, data: { recordsUsed: 250 } });
    const result = await assertQuotaAvailable({ prisma, shop: SHOP, now: AUG_15 });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/used all 250 records/i);
    expect(result.message).toMatch(/upgrade/i);
  });

  it("always allows an unlimited (Pro/Agency) shop, even with heavy usage recorded", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.AGENCY, now: AUG_15 });
    await prisma.shopPlan.update({ where: { shop: SHOP }, data: { recordsUsed: 999999 } });
    const result = await assertQuotaAvailable({ prisma, shop: SHOP, now: AUG_15 });
    expect(result.ok).toBe(true);
  });
});

describe("recordUsageAndCheck", () => {
  it("increments recordsUsed by the given count (defaults to 1)", async () => {
    const prisma = fakePrisma();
    await recordUsageAndCheck({ prisma, shop: SHOP, now: AUG_15 });
    await recordUsageAndCheck({ prisma, shop: SHOP, count: 4, now: AUG_15 });
    const status = await getUsageStatus({ prisma, shop: SHOP, now: AUG_15 });
    expect(status.used).toBe(5);
  });

  it("reports limitReached exactly when a capped plan's quota hits zero remaining", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await prisma.shopPlan.update({ where: { shop: SHOP }, data: { recordsUsed: 248 } });

    const first = await recordUsageAndCheck({ prisma, shop: SHOP, now: AUG_15 });
    expect(first.status.used).toBe(249);
    expect(first.limitReached).toBe(false);

    const second = await recordUsageAndCheck({ prisma, shop: SHOP, now: AUG_15 });
    expect(second.status.used).toBe(250);
    expect(second.limitReached).toBe(true);
  });

  it("never reports limitReached for an unlimited plan, no matter how much usage accrues", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.PRO, now: AUG_15 });
    await prisma.shopPlan.update({ where: { shop: SHOP }, data: { recordsUsed: 100000 } });
    const result = await recordUsageAndCheck({ prisma, shop: SHOP, now: AUG_15 });
    expect(result.limitReached).toBe(false);
  });

  it("still tracks usage on unlimited plans, even though it's never enforced", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.PRO, now: AUG_15 });
    await recordUsageAndCheck({ prisma, shop: SHOP, count: 12, now: AUG_15 });
    const status = await getUsageStatus({ prisma, shop: SHOP, now: AUG_15 });
    expect(status.used).toBe(12);
  });

  it("treats a zero or negative count as a no-op read, never decrementing or crashing", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await prisma.shopPlan.update({ where: { shop: SHOP }, data: { recordsUsed: 10 } });
    const zero = await recordUsageAndCheck({ prisma, shop: SHOP, count: 0, now: AUG_15 });
    const negative = await recordUsageAndCheck({ prisma, shop: SHOP, count: -5, now: AUG_15 });
    expect(zero.status.used).toBe(10);
    expect(negative.status.used).toBe(10);
  });

  it("applies month rollover before incrementing, so a new month starts counting from 0", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await prisma.shopPlan.update({ where: { shop: SHOP }, data: { recordsUsed: 250 } });

    const result = await recordUsageAndCheck({ prisma, shop: SHOP, now: SEP_2 });
    expect(result.status.used).toBe(1);
    expect(result.limitReached).toBe(false);
  });
});

describe("setShopTier", () => {
  it("changes tier and subscription fields without resetting usage already recorded this month", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await recordUsageAndCheck({ prisma, shop: SHOP, count: 30, now: AUG_15 });

    const status = await setShopTier({
      prisma, shop: SHOP, tier: PLAN_IDS.PRO,
      subscriptionId: "gid://shopify/AppSubscription/1", subscriptionStatus: "ACTIVE", now: AUG_15,
    });

    expect(status.tier).toBe(PLAN_IDS.PRO);
    expect(status.used).toBe(30);
    expect(status.subscriptionId).toBe("gid://shopify/AppSubscription/1");
    expect(status.subscriptionStatus).toBe("ACTIVE");
  });

  it("creates the shop's row first if it doesn't exist yet", async () => {
    const prisma = fakePrisma();
    const status = await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.PRO, now: AUG_15 });
    expect(status.tier).toBe(PLAN_IDS.PRO);
  });

  // Billing audit — Phase 7: a shop that racked up heavy usage on an
  // unlimited plan and then downgrades (or has its subscription cancelled)
  // mid-month must be blocked gracefully, not crash on a negative
  // "remaining", and not keep writing as if still unlimited.
  it("blocks further usage immediately (without a negative remaining or a crash) when a downgrade lands usage far past the new lower limit", async () => {
    const prisma = fakePrisma();
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.PRO, now: AUG_15 });
    await recordUsageAndCheck({ prisma, shop: SHOP, count: 10000, now: AUG_15 }); // way past Free's 250

    const status = await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.FREE, subscriptionId: null, subscriptionStatus: null, now: AUG_15 });
    expect(status.used).toBe(10000); // usage counter is untouched by the tier change itself
    expect(status.remaining).toBe(0); // clamped, never negative

    const gate = await assertQuotaAvailable({ prisma, shop: SHOP, now: AUG_15 });
    expect(gate.ok).toBe(false);
    expect(gate.message).toMatch(/used all 250 records/i);

    // A write attempted anyway (e.g. a caller that skipped the gate) must
    // still not crash or under/overflow — it just reports the cap as hit.
    const write = await recordUsageAndCheck({ prisma, shop: SHOP, count: 1, now: AUG_15 });
    expect(write.limitReached).toBe(true);
    expect(write.status.remaining).toBe(0);
  });

  it("recovers automatically once the calendar month rolls over, even after a heavy-usage downgrade", async () => {
    const prisma = fakePrisma();
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.PRO, now: AUG_15 });
    await recordUsageAndCheck({ prisma, shop: SHOP, count: 10000, now: AUG_15 });
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.FREE, subscriptionId: null, subscriptionStatus: null, now: AUG_15 });

    const nextMonth = await assertQuotaAvailable({ prisma, shop: SHOP, now: SEP_2 });
    expect(nextMonth.ok).toBe(true);
    expect(nextMonth.status.used).toBe(0);
    expect(nextMonth.status.remaining).toBe(250);
  });
});

// ═══════════════════════════════════════════════════════════════════
// Built-in AI (Groq) usage — independent counter, independent rollover,
// gated by tier on top of the quota check (unlike records, which every
// tier gets some allowance for).
// ═══════════════════════════════════════════════════════════════════

describe("getAiUsageStatus", () => {
  it("reports a fresh Free shop as ineligible with 0/500 used", async () => {
    const prisma = fakePrisma();
    const status = await getAiUsageStatus({ prisma, shop: SHOP, now: AUG_15 });
    expect(status).toMatchObject({ tier: PLAN_IDS.FREE, allowed: false, limit: AI_MONTHLY_CALL_CAP, used: 0, remaining: AI_MONTHLY_CALL_CAP });
  });

  it("reports Pro/Agency as eligible", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.AGENCY, now: AUG_15 });
    const status = await getAiUsageStatus({ prisma, shop: SHOP, now: AUG_15 });
    expect(status.allowed).toBe(true);
  });

  it("rolls AI usage over to 0 on a new calendar month, independent of the records period", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.PRO, now: AUG_15 });
    await recordAiUsage({ prisma, shop: SHOP, count: 40, now: AUG_15 });

    const augStatus = await getAiUsageStatus({ prisma, shop: SHOP, now: AUG_15 });
    expect(augStatus.used).toBe(40);

    const sepStatus = await getAiUsageStatus({ prisma, shop: SHOP, now: SEP_2 });
    expect(sepStatus.used).toBe(0);
    expect(sepStatus.remaining).toBe(AI_MONTHLY_CALL_CAP);
  });

  it("does not roll over records usage when only the AI period advances, and vice versa", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.PRO, now: AUG_15 });
    await recordUsageAndCheck({ prisma, shop: SHOP, count: 10, now: AUG_15 });
    await recordAiUsage({ prisma, shop: SHOP, count: 5, now: AUG_15 });

    // Reading AI status at a later month rolls ONLY the AI counter.
    const aiStatus = await getAiUsageStatus({ prisma, shop: SHOP, now: SEP_2 });
    expect(aiStatus.used).toBe(0);
    const recordStatus = await getUsageStatus({ prisma, shop: SHOP, now: AUG_15 });
    expect(recordStatus.used).toBe(10); // untouched — records period hasn't rolled at AUG_15
  });
});

describe("assertAiQuotaAvailable", () => {
  it("refuses a Free-tier shop regardless of usage, pointing at BYOK as a fallback", async () => {
    const prisma = fakePrisma();
    const result = await assertAiQuotaAvailable({ prisma, shop: SHOP, now: AUG_15 });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/requires the Pro or Agency plan/i);
    expect(result.message).toMatch(/your own Anthropic or OpenAI key/i);
  });

  it("allows a Pro shop with remaining budget", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.PRO, now: AUG_15 });
    const result = await assertAiQuotaAvailable({ prisma, shop: SHOP, now: AUG_15 });
    expect(result.ok).toBe(true);
  });

  it("refuses an eligible shop once the shared 500-call budget is exhausted, pointing at BYOK", async () => {
    const prisma = fakePrisma();
    await getOrCreateShopPlan({ prisma, shop: SHOP, now: AUG_15 });
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.AGENCY, now: AUG_15 });
    await recordAiUsage({ prisma, shop: SHOP, count: AI_MONTHLY_CALL_CAP, now: AUG_15 });

    const result = await assertAiQuotaAvailable({ prisma, shop: SHOP, now: AUG_15 });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(new RegExp(`${AI_MONTHLY_CALL_CAP} built-in AI suggestions`));
    expect(result.message).toMatch(/your own Anthropic or OpenAI key/i);
  });
});

describe("recordAiUsage", () => {
  it("increments aiCallsUsed by the given count (defaults to 1)", async () => {
    const prisma = fakePrisma();
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.PRO, now: AUG_15 });
    await recordAiUsage({ prisma, shop: SHOP, now: AUG_15 });
    await recordAiUsage({ prisma, shop: SHOP, count: 4, now: AUG_15 });
    const status = await getAiUsageStatus({ prisma, shop: SHOP, now: AUG_15 });
    expect(status.used).toBe(5);
  });

  it("reports limitReached exactly when the shared cap hits zero remaining", async () => {
    const prisma = fakePrisma();
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.PRO, now: AUG_15 });
    await recordAiUsage({ prisma, shop: SHOP, count: AI_MONTHLY_CALL_CAP - 1, now: AUG_15 });

    const first = await recordAiUsage({ prisma, shop: SHOP, now: AUG_15 });
    expect(first.status.used).toBe(AI_MONTHLY_CALL_CAP);
    expect(first.limitReached).toBe(true);
  });

  it("never records usage for a zero or negative count", async () => {
    const prisma = fakePrisma();
    await setShopTier({ prisma, shop: SHOP, tier: PLAN_IDS.PRO, now: AUG_15 });
    await recordAiUsage({ prisma, shop: SHOP, count: 0, now: AUG_15 });
    const status = await getAiUsageStatus({ prisma, shop: SHOP, now: AUG_15 });
    expect(status.used).toBe(0);
  });

  it("does not require the shop to be eligible — recording is separate from the gate", async () => {
    // Defensive: a shop that downgraded mid-call shouldn't crash the write
    // path if a caller somehow reaches recordAiUsage after the gate.
    const prisma = fakePrisma();
    const result = await recordAiUsage({ prisma, shop: SHOP, now: AUG_15 });
    expect(result.status.used).toBe(1);
  });
});
