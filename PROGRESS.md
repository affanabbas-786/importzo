# Importzo Hardening — Progress Log

Tracks execution of `Importzo-PRD-Growth-Plan.md`. Currently: **Phase 1 (Core Hardening) — complete.**
Phase 2, 3, 4 have not been started, per instructions.

Original work: five commits on `phase-1-hardening`, one per Phase 1 checklist item, each committed only
after the full test suite passed. That branch was subsequently merged into `main` (fast-forward,
outside this session) along with a separately-added PRD/growth-plan doc commit; all further work
described below happened directly on `main`.

---

## Post-Phase-1 fix: invalid GraphQL fields found via manual production testing

**Commit:** `8561abe` (on `main`)

The user ran a real store-to-store transfer (demo-2-offofpnp.myshopify.com → check-12313180.myshopify.com)
while manually verifying the metafields fix, and reported two symptoms:

1. **Confirmed and fixed:** `migration-worker.server.js`'s `PRODUCT_QUERY` requested `Product.giftCard`
   (doesn't exist as a query field — only `ProductInput.giftCard` exists, for mutations; the correct
   field is `isGiftCard`), `ProductVariant.fulfillmentService` (removed from the API in version 2022-10),
   and `ProductVariant.requiresShipping` (moved onto `InventoryItem` at some point). Verified against
   shopify.dev's live GraphQL reference for the pinned API version (2025-10, from
   `ApiVersion.October25` in `app/shopify.server.js` — note `shopify.app.toml`'s `[webhooks] api_version
   = "2026-04"` is a separate, webhook-only setting and not what these queries use). A single invalid
   field fails the *entire* query to parse, so every page fetch failed immediately and the whole
   migration job aborted. Fixed the query and the two call sites that read the affected fields; added
   regression tests asserting the actual query text sent is well-formed.

2. **Investigated, not independently reproduced:** a second symptom — repeated GraphQL "syntax error,
   unexpected INT (<large number>)" — was suspected to involve an inventory item ID interpolated
   unquoted into a query string. Searched exhaustively across every GraphQL call site in the codebase
   (every raw ID usage, every dynamic query-string construction, every `inventoryItemId` reference) and
   found no second occurrence of a pattern that produces that specific error class. The only place in
   the entire codebase that could produce exactly "unexpected INT" (a numeric value landing in a
   GraphQL *field-name* position, not just an argument value) is `copyMetafields`/
   `copyGraphqlMetafields`'s `resourceType` derivation — already fixed in the Phase 1 metafields commit
   (`69b1c52`). Reported this back rather than inventing an unverifiable second fix. If it still
   reproduces after this commit, the exact log line and which entity type (product/page/collection/
   article) triggered it would pinpoint it definitively.

---

## Sequencing note

The PRD lists Phase 1 items in this order: (1) clone/migration regression tests, (2) import/export
regression tests, (3) idempotency, (4) rate-limiting, (5) large-file streaming. I implemented them in
the reverse-ish order **4 → 5 → 3 → 2 → 1** instead, because:

- Rate-limit handling (4) was duplicated three different ways across the codebase already (and missing
  entirely in three routes) — fixing that first meant every later regression test could exercise one
  well-tested implementation instead of three drifting ones.
- Idempotency (3) and streaming/scale (5) changes needed to land *before* the regression suites (1, 2)
  so those suites would test the final code, not code about to be rewritten underneath them.

All five items are still fully implemented and tested; only the order changed.

---

## Task 4 — Rate-limit handling against Shopify Admin API
**Commit:** `3e6c845` · **Tests:** 14 new (in `app/lib/shopify-api.server.test.js`)

- Found the 429-backoff + GraphQL cost-throttle logic duplicated three times (`migration-worker.server.js`,
  `app.transfer.jsx`, `app.export.jsx`) — three independent copies that could silently drift apart.
  Extracted a single shared `app/lib/shopify-api.server.js` (`shopifyFetch` + `shopifyGraphql`), with an
  injectable `sleep`/`maxRetries` factory so tests run instantly instead of waiting on real backoff delays.
- Found **zero retry/backoff coverage** in `app.product-importer.jsx`, `app.collections.jsx`, and
  `app.inventory.jsx` — a 429 during a CSV import just failed that row outright. Wired the shared helper
  into all three.
- Files changed: `app/lib/shopify-api.server.js` (new), `app/lib/migration-worker.server.js`,
  `app/routes/app.transfer.jsx`, `app/routes/app.export.jsx`, `app/routes/app.product-importer.jsx`,
  `app/routes/app.collections.jsx`, `app/routes/app.inventory.jsx`.

## Task 5 — Large file support (streaming / 50k+ SKU scale)
**Commit:** `a708e0d` · **Tests:** 25 in `csv-parser.test.js` (was 19), + coverage folded into the route tests below

- `csv-parser.js`: added `parseCSVRows()`, a generator that yields rows as they complete instead of
  building the full 2D array up front. `parseCSV()` is now a thin eager wrapper over it — every existing
  caller is unaffected. Tested at 50k rows, plus a laziness check (consuming only the first row never
  scans the rest of the file).
- `app.inventory.jsx`: the SKU-lookup loop issued **one GraphQL round trip per row** — the dominant
  bottleneck for large inventory files. Now batches up to 25 SKUs per lookup via a single
  `productVariants(query: "sku:... OR sku:...")` call, with a safe per-batch fallback to the original
  per-item lookup if the batched call fails. Writes run with bounded concurrency (5 at a time); results
  are re-sorted by row afterward since concurrent completions can settle out of order.
- `app.product-importer.jsx` / `app.collections.jsx`: converted the fully-sequential per-row await loop
  to bounded-concurrency batches of 5 (mirroring `migration-worker.server.js`'s existing
  `CREATE_CONCURRENCY` pattern).
- **Known, documented limitation (not fixed in this pass):** these three CSV routes still process an
  entire file within one synchronous HTTP request/response cycle. The changes above cut wall-clock time
  and peak memory substantially, but a true fix for arbitrarily large files needs the same
  background-job + polling architecture `migration-worker.server.js` already uses for clone/migration.
  I deliberately did not bundle that rearchitecture into a hardening pass — it's a UX/architecture change
  (the "Importing..." step would need to become a poll loop), not a bug fix. Flagging as a good Phase 2+
  candidate if 50k+ row CSV imports (not just clone/migration) are validated as a real usage pattern.

## Task 3 — Idempotency (re-running must not duplicate data)
**Commit:** `868caf8` · **Tests:** folded into the route test files below

Four real gaps found:
- `app.product-importer.jsx`: `productCreate` was unconditional. Now looks up an existing product by
  handle first; if found, the row is reported as skipped instead of duplicated.
- `app.collections.jsx`: same issue for `collectionCreate`. Since this importer doesn't map a handle,
  **title** is the practical dedupe key.
- `app.transfer.jsx` `copyStoreFiles()`: `fileCreate` had zero dedupe — re-running a content transfer
  duplicated every file. Now fetches the destination's existing files first and skips filenames already
  present.
- `app.transfer.jsx` `transfer-theme`: there's no "update" path for a ZIP-sourced theme, so every retry
  created a brand-new theme — eventually exhausting the destination store's theme-count limit. Now checks
  the destination's theme list for a name match before creating a new one.

Products/pages/blogs/menus already had handle-based upsert-in-place behavior from before this session —
confirmed via the Task 1 tests, not assumed.

## Task 2 — Regression tests: import/export flow
**Commit:** `b33700e` · **Tests:** 10 new (`test/routes/app.export.test.js`)

`app.export.jsx` (products/collections/inventory/customers CSV export) had zero test coverage. Added
tests for: store counts, per-variant CSV rows, pagination across multiple GraphQL pages, smart-vs-custom
collection typing, inventory rows skipping SKU-less variants, customer export, the 403 response when
`read_customers`/protected-data approval is missing, 429 retry-then-succeed, and unknown-intent/500
response shapes. (`product-importer`/`collections`/`inventory` import routes were already covered as
part of the Task 3/5 commits.)

## Task 1 — Regression tests: clone/migration flow
**Commit:** `69b1c52` · **Tests:** 7 new (`migration-worker.server.test.js`) + 7 new (`app.transfer.test.js`)

Covers the entities named explicitly in the PRD checklist:
- **products** — full creation, resumability (doesn't re-create products already marked DONE), per-product
  failure isolation (one bad product doesn't fail the whole job), conflictMode=skip.
- **themes** — covered by Task 3's dedupe tests.
- **media** — non-image media / image upload paths exercised via the products tests (empty-media happy path).
- **pages** — create-new and update-existing-by-handle.
- **blogs, menus** — menu transfer, including the existing (and now regression-tested) behavior of
  filtering out unsupported `CUSTOMER_ACCOUNT_PAGE` menu items instead of failing the whole menu.
- **metafields** — see bug below.

### Bug found by these tests and fixed
Both `copyMetafields` (`migration-worker.server.js`) and `copyGraphqlMetafields` (`app.transfer.jsx`)
derived the GraphQL resource-type field name via `sourceGid.split("/")[4]`. For a GID like
`gid://shopify/Product/123`, splitting on `/` gives `["gid:", "", "shopify", "Product", "123"]` — index 4
is the **numeric ID**, not the type; index 3 is. The query built was therefore always invalid GraphQL
(e.g. a field literally named `123`), silently failing and being swallowed by a catch block that just
logs a warning.

**Practical effect: metafields have never been successfully copied by any transfer path** (products,
collections, pages, blogs, articles) — not a regression from this session, a pre-existing bug this
session's testing surfaced. Fixed to use index 3; the fix is verified by asserting the actual GraphQL
query text uses the correct field name (`"product"`, `"page"`, etc.), not just that the call didn't throw.

This is not billing/OAuth/webhook-signature work, so it didn't require stopping for review per the PRD's
loop instructions — but it's flagged here prominently since it's the most consequential finding of this
pass.

---

## Test suite summary

```
Test Files  9 passed (9)
     Tests  111 passed (111)
```

| File | Tests |
|---|---|
| `app/lib/csv-parser.test.js` | 25 |
| `app/lib/smart-mapper.test.js` | 20 (pre-existing, unchanged) |
| `app/lib/shopify-api.server.test.js` | 14 |
| `app/lib/migration-worker.server.test.js` | 7 |
| `test/routes/app.product-importer.test.js` | 9 |
| `test/routes/app.collections.test.js` | 7 |
| `test/routes/app.inventory.test.js` | 8 |
| `test/routes/app.export.test.js` | 10 |
| `test/routes/app.transfer.test.js` | 12 |

Route-level tests live in a top-level `test/routes/` directory rather than `app/routes/` because
`@react-router/fs-routes` treats every file under `app/routes/` as a route module (confirmed via
generated `+types` stubs) and would have quietly registered the test files as live app routes.

`npx eslint` was run after every commit; only pre-existing baseline errors remain (confirmed by diffing
against the pre-session baseline) — no new lint errors were introduced.

## Files changed (all commits combined)

**New:**
- `app/lib/shopify-api.server.js` + `.test.js`
- `app/lib/test-helpers.js`
- `app/lib/migration-worker.server.test.js`
- `test/routes/app.product-importer.test.js`
- `test/routes/app.collections.test.js`
- `test/routes/app.inventory.test.js`
- `test/routes/app.export.test.js`
- `test/routes/app.transfer.test.js`

**Modified:**
- `app/lib/csv-parser.js`, `app/lib/csv-parser.test.js`
- `app/lib/migration-worker.server.js`
- `app/routes/app.transfer.jsx`
- `app/routes/app.export.jsx`
- `app/routes/app.product-importer.jsx`
- `app/routes/app.collections.jsx`
- `app/routes/app.inventory.jsx`

---

## What I did not touch

- Phase 2 (backup/snapshot, dry-run diff view, rollback, detailed logs, scheduled sync), Phase 3
  (encryption-at-rest audit, scope minimization, GDPR webhook verification, own-API rate limiting, audit
  logging, HMAC verification, `npm audit`), and Phase 4 (WooCommerce import, markets/multi-currency,
  mapping templates, AI cleanup) — not started, per instructions.
- No billing, OAuth, or webhook-signature code was touched, so nothing required stopping for human
  review under the PRD's loop instructions.
- The full-file-in-one-HTTP-request architecture limit for CSV import/export (see Task 5) — documented,
  not fixed, since fixing it properly means a UX change (polling), not just a hardening fix.

## Next step

Waiting for review/confirmation before starting Phase 2 (Trust & Safety features: pre-transfer
backup/snapshot, dry-run diff view, rollback, detailed per-record logs, scheduled sync).
