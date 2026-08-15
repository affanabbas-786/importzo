import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// ═══════════════════════════════════════════════════════════════════
// Phase 3 — Scope minimization guard.
//
// Requesting a scope the app never uses is both a security smell and a
// conversion cost (merchants see a longer permission list at install).
// This pins the audited set so a scope can't be quietly re-added without
// a corresponding decision.
// ═══════════════════════════════════════════════════════════════════

const ROOT = process.cwd();

function declaredScopes() {
  const toml = fs.readFileSync(path.join(ROOT, "shopify.app.toml"), "utf8");
  // Only the uncommented scopes= line (comments above it also contain
  // scope names, which must not be picked up).
  const line = toml.split("\n").find((l) => l.trim().startsWith("scopes ="));
  const match = line?.match(/scopes\s*=\s*"([^"]*)"/);
  return (match?.[1] || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Reads every source file the app actually ships.
function appSource() {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|jsx|ts|tsx)$/.test(entry.name) && !entry.name.includes(".test.")) {
        files.push(fs.readFileSync(full, "utf8"));
      }
    }
  };
  walk(path.join(ROOT, "app"));
  return files.join("\n");
}

describe("OAuth scope minimization", () => {
  const scopes = declaredScopes();
  const source = appSource();

  it("declares a non-empty scope list", () => {
    expect(scopes.length).toBeGreaterThan(0);
  });

  // The finding this phase acted on: read_orders was requested but the
  // codebase contains no order API call at all.
  it("does not request read_orders, which no code path uses", () => {
    expect(scopes).not.toContain("read_orders");
    expect(scopes).not.toContain("write_orders");
  });

  it("has no order/draftOrder/fulfillmentOrder query that would justify re-adding an orders scope", () => {
    // Deliberately narrow patterns: a bare "order" matches sortOrder,
    // reorder, "in order to", etc.
    const orderApiPatterns = [
      /\borders\s*\(\s*first:/,
      /\bdraftOrders?\s*\(/,
      /\bfulfillmentOrders?\s*\(/,
      /\bordersCount\b/,
      /mutation\s+\w*[Oo]rder(Create|Update|Delete)/,
    ];
    const hits = orderApiPatterns.filter((re) => re.test(source)).map(String);
    expect(
      hits,
      `Found order-API usage — if this is intentional, read_orders must be re-added to shopify.app.toml: ${hits.join(", ")}`,
    ).toEqual([]);
  });

  it("matches the audited scope set exactly, so additions require a deliberate change here", () => {
    // Update this list ONLY alongside a documented justification in
    // shopify.app.toml's audit comment.
    expect([...scopes].sort()).toEqual([
      "read_content",
      "read_customers",
      "read_files",
      "read_inventory",
      "read_legal_policies",
      "read_markets", // Phase 4.2 — Markets-scoped transfer, see shopify.app.toml
      "read_online_store_navigation",
      "read_online_store_pages",
      "read_products",
      "read_themes",
      "write_content",
      "write_files",
      "write_inventory",
      "write_online_store_navigation",
      "write_products",
      "write_themes",
    ].sort());
  });

  it("still requests every scope the app demonstrably needs", () => {
    // Spot-check the load-bearing ones against real usage, so a future
    // over-eager minimization can't silently break a feature.
    const required = [
      ["read_products", /products\s*\(\s*first:/],
      ["write_products", /mutation\s+ProductCreate/],
      ["write_inventory", /inventorySetQuantities/],
      ["write_files", /mutation\s+fileCreate/],
      ["write_content", /mutation\s+PageCreate/],
      ["write_online_store_navigation", /mutation\s+CreateMenu/],
      ["read_legal_policies", /shopPolicies/],
      ["read_customers", /customers\s*\(\s*first:/],
      ["read_markets", /markets\s*\(\s*first:/],
    ];
    for (const [scope, usage] of required) {
      if (usage.test(source)) {
        expect(scopes, `${scope} is used in code but not declared`).toContain(scope);
      }
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
// The gap that let the audited set above drift out of reality.
//
// shopify.server.js configures the app with `scopes: process.env.SCOPES`,
// NOT with the toml's scopes line — so the guard above was pinning a value
// the running app never reads. They diverged: while the toml documented
// removing read_orders after auditing that no order API call exists, .env
// still requested read_orders, write_orders, read_draft_orders,
// write_draft_orders, write_customers, read/write_price_rules,
// read/write_discounts and read/write_collections. The live Session rows
// showed the consequence — older installs carry read_orders in their
// granted scope string.
//
// These tests read the env files as text (not process.env) so they check
// what is actually on disk regardless of what the test runner has loaded.
// ═══════════════════════════════════════════════════════════════════
describe("SCOPES env stays in step with shopify.app.toml", () => {
  const declared = declaredScopes();

  function envScopes(filename) {
    const full = path.join(ROOT, filename);
    if (!fs.existsSync(full)) return null;
    const line = fs.readFileSync(full, "utf8")
      .split("\n")
      .find((l) => l.trim().startsWith("SCOPES="));
    if (!line) return null;
    return line.slice(line.indexOf("=") + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // .env itself is gitignored and absent from CI, so it is checked only when
  // present — which is exactly the case that matters, on the server.
  for (const filename of [".env", ".env.development.example"]) {
    it(`${filename} declares the same scope set as shopify.app.toml`, () => {
      const scopes = envScopes(filename);
      if (scopes === null) return; // file or key not present — nothing to drift
      expect([...scopes].sort()).toEqual([...declared].sort());
    });
  }

  it("no env file smuggles in a scope the audit removed", () => {
    const removed = [
      "read_orders", "write_orders",
      "read_draft_orders", "write_draft_orders",
      "write_customers",
      "read_price_rules", "write_price_rules",
      "read_discounts", "write_discounts",
    ];
    for (const filename of [".env", ".env.development.example"]) {
      const scopes = envScopes(filename);
      if (scopes === null) continue;
      for (const scope of removed) {
        expect(scopes, `${filename} still requests ${scope}, which no code path uses`).not.toContain(scope);
      }
    }
  });
});
