# Importzo Hardening — Progress Log

Tracks execution of `Importzo-PRD-Growth-Plan.md`. Currently: **Phases 1 and 2 complete and deployed.
Phase 3 (Security Hardening) — all 7 PRD items committed EXCEPT item 3.1 (token encryption), which is
implemented but UNCOMMITTED awaiting your explicit review.** Phase 4 has not been started.

**Test suite: 491 passing across 26 files** (455 → 491 with audit logging; 133 at end of Phase 1).

---

# PHASE 3 — Security Hardening

Committed:

| Commit | Item |
|---|---|
| `4b49d41` | 3.3 GDPR webhooks + 3.5 webhook HMAC verification |
| `1aabaee` | 3.4 Rate limiting / abuse protection |
| `24dc424` | 3.6 Dependency vulnerability scan |
| `dd4cbe4` | 3.2 Scope minimization |
| `3105863` | Fix: TransferSession survived GDPR erasure (found by live smoke test) |
| `9a29efe` | 3.7 Audit logging |

**NOT committed — item 3.1 (token encryption at rest).** Implemented and fully tested, held per your
instruction to stop before committing changes to token/session storage. Details in its own section
below.

## 🔴 Decisions needed

**1. react-router 7.13.2 RCE — upgrade VERIFIED on a branch, ready for staging. Not merged.**

Branch `fix-rce-upgrade` (local only, commit `12d7d79`, not pushed). Regenerating `node_modules` +
lockfile cleared the resolver deadlock immediately — it was purely stale lockfile state, not a real
version conflict. react-router 7.18.1 installs cleanly.

Clears **9 of 10** advisories including the unauthenticated RCE (vendored turbo-stream `TYPE_ERROR`
deserialization), open redirects, CSRF on document requests, XSS and DoS. Only "RSC Mode CSRF Bypass"
remains — needs 8.3.0 (major) and applies to RSC mode this app doesn't use.

Verified on the branch: 427 tests pass (455 minus the 28 stashed encryption tests), `npm run build`
exits 0, no server-module leakage into the client bundle, `npm run dev` boots and tunnels to the dev
store, the built server boots and SSRs, auth rejects unauthenticated requests, and webhook HMAC both
**rejects unsigned** requests and **accepts correctly-signed** ones.

Two caveats: v8 future-flag deprecation warnings now appear (informational only), and this was
verified against a dev store, not production traffic. **Recommended: deploy the branch to staging,
then merge.** It is the highest-severity item still open.

**2. Token encryption is now fail-closed — verify your production key before deploying.**
The uncommitted item 3.1 makes `encrypt()` throw rather than silently write plaintext. If
`ENCRYPTION_KEY` is unset **or shorter than 32 characters** in production, the app will start failing
on token writes immediately after deploy. Check it before this ships. (The 32-char minimum already
caught a too-short key in our own test fixture.)

**3. 🚨 The committed migration chain cannot build a working database. NOT fixed.**
Found while smoke-testing: `MigrationJob`, `ProductMapping` and `TransferSession` are created by **no
committed migration**. They exist only via `prisma/migrations/20260728094337_local_dev_setup/`, which
has been **untracked in git** the whole time (it was already untracked before this work began).

`prisma migrate deploy` against a fresh database fails hard at `20260729020000_add_store_backup` with
`no such table: MigrationJob`, and Prisma then blocks every later migration. Your `npm run setup` and
`deploy.sh` both run `prisma migrate deploy`, so **any rebuild, new environment, or fresh deploy is
broken.** Existing production is presumably fine because its tables predate this.

I did not fix it because there are two valid approaches with real trade-offs — commit the missing
migration as-is, or squash a new baseline — and picking one affects your migration history
permanently. Worth resolving before the next deploy.

**4. Scope change triggers merchant re-authorization.**
`dd4cbe4` removes `read_orders`. Shopify will prompt existing merchants to approve the updated
(shorter) permission set on next load. Normal for a scope change, but merchant-visible — deploy
deliberately.

**5. `read_customers` vs the published privacy policy — your call.**
The PRD asked to audit scopes "against the privacy policy already published". `app/routes/privacy.jsx`
says the app does "not collect personal information about your customers (names, emails, addresses,
payment data)". That is literally true — the customer CSV export streams to the merchant's browser and
is never persisted, which I verified and pinned with a test. But the app does **read** that data, and
`read_customers` is Shopify "protected customer data" requiring separate approval. Two questions for
you: should the policy say "access" rather than only "collect", and is protected-customer-data
approval in place? Both are decisions about published legal copy, so I left them alone.

## 3.3 — GDPR compliance webhooks (`4b49d41`)

**Serious finding: erasure was incomplete.** `shop/redact` deleted 3 of the app's 9 tables. It left
behind:

| Table | What survived a legally-mandated erasure |
|---|---|
| `MigrationJob` | encrypted source **and** destination access tokens |
| `ScheduledSync` | encrypted tokens, and the schedule stayed enabled |
| `StoreBackup` | a full snapshot of the shop's product catalog |
| `TransferSession`, `ProductMapping`, `TransferLogEntry` | transfer history |

Four of those six are Phase 2 tables I added, and I did not extend `shop/redact` when adding them.
That is the gap that caused this, and it is the kind of thing that recurs, so the fix is structural:
`app/lib/shop-data.server.js` is now the single source of truth, and **a test reads
`prisma/schema.prisma` directly and fails if any declared model is neither wired into erasure nor
explicitly exempted with a reason.** Adding a model without handling erasure now breaks the build.

Deletion is children-before-parents (`ProductMapping`/`TransferLogEntry` have no `shop` column and
hang off `MigrationJob` by `jobId`), per-model best-effort so a missing table can't abort the rest, and
every failure is logged loudly rather than silently under-deleting.

`app/uninstalled` also now disables the shop's `ScheduledSync` rows — the offline token is revoked at
uninstall, so an enabled schedule would keep firing against a dead credential. Uninstall is still not
erasure; `shop/redact` does that 48h later, and a test pins the distinction.

## 3.5 — Webhook HMAC verification (`4b49d41`)

All five webhook routes already delegated to `authenticate.webhook()`, which performs the signature
verification. That was correct and is **unchanged** — but it was untested. Now, for every route: a
rejected signature performs no destructive work and the 401 propagates rather than being swallowed
into a 200.

`app/uninstalled` deliberately tolerates one post-verification failure (the SDK's token refresh
against an already-revoked token). A test pins that this tolerance does **not** extend to genuine
401/400/405 auth failures — that distinction is the whole safety of the fallback.

## 3.4 — Rate limiting (`1aabaee`)

Two controls, because they stop different things: a rate limit stops a client hammering an endpoint;
a concurrency cap stops a few simultaneous but very expensive operations. Three full-store backups
started three seconds apart are only 3 requests but will saturate the box.

Everything is keyed **per shop**, which is the "one shop can't starve others" requirement, pinned by
tests on both dimensions. Backup/restore/rollback are capped at 1 concurrent per shop; preview at 2.
`withPolicy()` releases in a `finally`, so a throwing handler can't wedge a shop out of its own
endpoint — tested, as is double-release being a no-op.

`api.migration-job` is handled differently on purpose: the worker is fire-and-forget and outlives the
request, so an in-process slot released at response time would cap nothing. It gets the rate limit
plus a **DB count of PENDING/RUNNING jobs** as the real concurrency control.

**Known limitation:** counters are in-process, so with multiple PM2 workers the effective limit is
per-worker. Redis/DB-backed counters would be exact but are real infrastructure; this still stops the
runaway-loop and thundering-herd cases the item exists for.

## 3.6 — Dependency scan (`24dc424`)

`npm audit`: 43 vulns (1 critical, 36 high, 5 moderate, 1 low) → 38 (0 critical, 38 high, 0 moderate,
0 low). Applied `npm audit fix` only — semver-compatible, **not** `--force`, and `package.json` is
unchanged (lockfile-only). Notably bumped vite 6.4.1 → 6.4.3 (path traversal, arbitrary file read via
dev-server websocket, `server.fs.deny` bypass).

The high count rising 36 → 38 is not a regression: resolving the tree surfaced advisories previously
masked behind the ones just fixed. Every remaining high is either the react-router cluster (decision
#1 above) or dev-only toolchain majors (`@typescript-eslint/*`, `eslint`, `@shopify/api-codegen-preset`)
which don't ship to production and can't be reached by a request.

## 3.2 — Scope minimization (`dd4cbe4`)

Audited all 16 declared scopes against real API usage. **Removed `read_orders`** — there is no
`orders`, `draftOrders`, `ordersCount` or `fulfillmentOrder` query anywhere in the codebase. It was
requested at install and never used once.

The other 15 each trace to a concrete call site, documented inline in `shopify.app.toml`.
`test/scopes.test.js` pins the audited set: it fails if `read_orders` returns, if any order-API call
appears without the scope being re-added, or if the declared list drifts. It also verifies that scopes
the code demonstrably needs are still declared, so a future over-eager minimization can't silently
break a feature.

## 3.1 — Token encryption at rest ⚠️ IMPLEMENTED, NOT COMMITTED

Held for your explicit review per instruction. Everything below is written, tested (28 tests) and
passing, sitting uncommitted in the working tree:

- `app/utils/encryption.server.js` (rewritten)
- `app/utils/encryption.server.test.js` (new)
- `scripts/reencrypt-tokens.mjs` (new)
- `test/routes/api.scheduled-sync.test.js` (fixture key lengthened)
- `.eslintrc.cjs` (Node env for `scripts/`)

**Four problems fixed:**

1. **Fail-open → fail-closed.** With `ENCRYPTION_KEY` unset, `encrypt()` logged a warning and
   returned the plaintext, which was then written to the database. Every OAuth token in
   `SourceStore`, `TransferSession`, `MigrationJob` and `ScheduledSync` would sit in the clear while
   the code read as though it were encrypting. It now throws. A test asserts explicitly that the
   plaintext can no longer be returned.
2. **Unauthenticated cipher → AES-256-GCM.** AES-256-CBC gave confidentiality but no integrity;
   ciphertext could be altered undetected. A test flips one ciphertext character and asserts GCM's
   auth tag rejects it — CBC would have decrypted it to garbage silently.
3. **No key validation.** Any non-empty string was accepted, including `"x"`. Now requires ≥32 chars
   and rejects entropy-free placeholders. Errors never echo the key.
4. **Errors swallowed.** `decrypt()` returned the raw input on failure, so a wrong key silently
   produced "tokens" that were really ciphertext, surfacing later as a baffling Shopify auth error.
   It now throws with a message naming the likely cause.

**Backward compatibility is preserved.** Storage is versioned (`v2:iv:tag:cipher`), and both legacy
forms — AES-CBC, and plaintext written while the fail-open path was live — remain **readable**, so
existing rows keep working. Nothing new is ever written in a legacy format. `scripts/reencrypt-tokens.mjs`
upgrades rows in place (`--dry-run` first; safe to re-run; leaves undecryptable values untouched
rather than destroying any chance of recovery).

**Why this needs your sign-off before it ships:**
- It changes behavior on every token write path in the app.
- If production's `ENCRYPTION_KEY` is missing or under 32 chars, **token writes will start failing
  immediately on deploy**. That is the intended fail-closed behavior, but it must be verified first.
- If the production key ever *changed*, existing rows encrypted under the old key will now throw
  instead of silently returning ciphertext. Affected stores would need to reconnect. Loud failure is
  correct, but you should know before rather than after.

Suggested order: confirm `ENCRYPTION_KEY` is set and ≥32 chars → back up the DB → deploy → run
`node scripts/reencrypt-tokens.mjs --dry-run` → review → run for real.

## 3.7 — Audit logging (`9a29efe`)

The PRD's seventh Phase 3 item (line 50), originally omitted from the task list, added on request.

`actorType`/`actorId`/`actorEmail`/`actorIp` on `TransferLogEntry` (`createdAt` is the "when"), and
the same four on `MigrationJob` for who triggered each transfer.

**The design point:** `runMigrationWorker` is fire-and-forget and outlives the request that started
it. By the time it writes log entries there is no request, no session and no IP — capturing the actor
at write time would attribute every background-written row to nobody. So attribution is captured at
**trigger** time onto `MigrationJob`, and the worker reads it back and stamps it onto every entry it
writes. Tested end-to-end: a job triggered by a staff user yields log rows carrying that user's
identity and IP, written minutes later by a detached worker.

Actor types: `user` (human in the admin), `schedule` (cron-driven, no IP by definition), `system`,
`unknown` (the default, including pre-migration rows).

Two deliberate honesty choices:
- This app uses **offline** Shopify sessions, which are shop-keyed, so staff `userId`/`email` are
  frequently null. Those actions are still recorded as `user`, not downgraded to `system` — a human
  did trigger them, and misattributing that is worse than a partial record.
- `extractClientIp` returns `null` when no usable proxy header exists, rather than inventing one.

**On `X-Forwarded-For`:** it is client-controllable and only meaningful because a trusted reverse
proxy (PM2 behind TLS termination) rewrites it. The left-most entry is taken as closest to the origin
client, but a determined client can forge it. It is recorded as best-effort evidence and is **never**
used as an authorization input — nothing in the app makes a security decision from `actorIp`.

GDPR: `actorEmail` is personal data. Both tables carrying it are already erased by `shop/redact`, and
a new test parses `schema.prisma` and fails if any model gains actor PII without being wired into
erasure. Verified it fires by temporarily adding a probe model.

`api/migration-status/:jobId` now returns a `triggeredBy` block.

---

Historical note: Phase 1 was five commits on `phase-1-hardening`, one per checklist item, each
committed only after the full suite passed. That branch was later merged into `main` (fast-forward,
outside this session) along with a separately-added PRD doc commit; everything after happened directly
on `main`.

---

# PHASE 2 — Trust & Safety Features (complete, deployed)

Five commits, one per checklist item, each landed only after the full suite passed:

| Commit | Item |
|---|---|
| `5484a3f` | 2.4 — Detailed per-record transfer logs |
| `c074f8a` | 2.1 — Pre-transfer backup/snapshot + one-click restore |
| `aa003cb` | 2.2 — Dry-run preview with a real create/update/skip diff |
| `acc2a71` | 2.3 — Rollback within a time window |
| `2bda58b` | 2.5 — Scheduled/recurring sync |

Implemented in dependency order rather than PRD order: detailed logs (2.4) first because backup,
rollback and scheduling all write to them; rollback (2.3) after backup (2.1) because the two are
complementary halves of a single undo. All five items are fully implemented either way.

## 🔴 Three things that need your decision

**1. Default behavior change — a failed backup now aborts the transfer.**
`MigrationJob.backupPolicy` defaults to `"require"`, so a job stops **before writing anything** if its
pre-transfer snapshot fails. The alternative default would let an irreversible transfer run with no way
back, which is the exact failure mode this phase exists to prevent — but it does mean a transfer that
would previously have succeeded (e.g. against a destination where the app lacks read scope for the
snapshot) will now fail with an explanatory error. `"best-effort"` (proceed with a loud warning) and
`"skip"` are both available per-job. **Tell me if you'd rather default to `"best-effort"`.**

**2. The scheduler needs an external cron + a new env var.**
`/api/scheduler-tick` is driven externally, not by an in-process `setInterval`, because the app runs
multiple PM2 workers and an interval in each would fire every schedule once per worker. To activate
recurring sync you need to:
- set `SCHEDULER_SECRET` in the environment (with it unset the endpoint returns 503 and no schedule
  ever runs — it fails closed rather than open), and
- add a cron hitting `POST /api/scheduler-tick` with header `x-scheduler-secret: <that value>`,
  every ~15 minutes.

**3. Backups have a hard size ceiling that a large destination will hit.**
Snapshots are JSON in a SQLite TEXT column, capped at 5000 products / 1000 collections. Past that the
backup is stored as `PARTIAL` and the job's error log states exactly how much is restorable. It does
not silently truncate — but on a big destination store, "one-click restore" genuinely only covers part
of the store. Moving snapshots to files or object storage is the real fix and is a bigger change than
belonged in this phase.

## 2.4 — Detailed per-record transfer logs (`5484a3f`)

The PRD asked to "verify it's genuinely granular, not just a summary count". It wasn't: per-record
history existed only for products via `ProductMapping`, only as `DONE|FAILED`, with no reason for a
skip and **no record at all** of pages/blogs/menus/files/themes/metafields. `MigrationJob.errorLog` is
a capped JSON summary of failures only.

New `TransferLogEntry` table + `app/lib/transfer-log.server.js`:
- `createLogBuffer()` — batches INSERTs (a 50k-product job must not issue 50k writes) and is
  best-effort by design: a logging failure can never abort an in-flight transfer.
- `normalizeEntry()` — throws on an unknown action so typos surface instead of storing junk.
- `fetchJobLog()` / `fetchJobLogSummary()` — read side, with limit clamping and DB-side aggregation.

The worker now logs every product as created/updated/skipped/failed **with its reason**, and every
metafield rejection as its own queryable entry. `/api/migration-status/:jobId` returns `logSummary`
plus a filterable page of entries (`?action=&entityType=&limit=&offset=`); the existing `errorLog` is
unchanged.

*Worth noting:* the worker's test fake had to gain a real `transferLogEntry` model — because the buffer
deliberately swallows write failures, without it those tests would have passed while logging silently
did nothing. That's the same trap the metafields bug fell into.

## 2.1 — Pre-transfer backup/snapshot (`c074f8a`)

`StoreBackup` table + `app/lib/backup.server.js` (`snapshotStore`, `createBackup`, `restoreBackup`,
`purgeExpiredBackups`, 30-day retention). Taken against the **destination**, before any write.

Two deliberate scope decisions, both to keep "undo" honest:
- Backup/restore reverts records a transfer **overwrote**. It does not delete records the transfer
  **created** — that's rollback. Neither is a complete undo alone.
- A product deleted since the snapshot is reported as failed, **not recreated**: recreating it would
  mint a different product ID and quietly diverge from what a merchant means by "undo".

Resumed jobs never re-snapshot — by then the destination already contains this transfer's writes, so
that snapshot would be useless as an undo point.

`/api/backup` (list/create/restore) scopes everything to the authenticated shop; another shop's backup
id returns the same "Backup not found" as a nonexistent one, and the list view never ships the payload.

## 2.2 — Dry-run preview with a real diff (`aa003cb`)

The existing dry run tagged every record `"dry-run"` and counted them. It could not answer the question
a merchant actually has: how many get **created**, how many **overwritten**, how many **left alone**.

`app/lib/transfer-diff.server.js` fetches the destination's handles **once** into an in-memory index,
then classifies purely against it — classifying per-product would be one round trip per product, which
is unusable at 50k for something that runs interactively. A test pins the request count to pages, not
products.

Three cases it calls out rather than glossing over:
- `conflictMode: "create"` against a colliding handle — Shopify doesn't reject it, it mints a suffixed
  handle, leaving a near-duplicate.
- An overwrite with no detectable field change is still a write, and says so.
- Duplicate handles **within the source itself**, where one silently clobbers the other.

Truncation is always propagated, never silent: a partial destination index would make existing products
look like they need creating.

## 2.3 — Rollback (`acc2a71`)

**This one closed a real data-loss hole.** `ProductMapping` recorded only `DONE|FAILED` — it had no
record of whether this app *created* a destination product or merely *skipped* one that already
existed. Rolling back off that data would have deleted the merchant's own pre-existing products.

`ProductMapping.action` now records `created|updated|skipped`, and rollback's rules are:

| action | rollback behavior |
|---|---|
| `created` | **deleted** — we made it; removing it restores the prior state |
| `skipped` | **never** — the handle already existed; this is the merchant's own product |
| `updated` | **never** — pre-existed and was overwritten; restore reverts it, deletion would destroy it |
| `unknown` | **never** — the column's default, so every row written before this migration is un-deletable: we can't prove we created it, so we assume we didn't |

Each rule has its own test. Other guards: 24h window from the job's last run; a job still running,
already rolled back, or belonging to another shop is refused before any delete is issued;
`rolledBackAt` is stamped even on partial failure so a retry can't re-attempt deletes against
already-deleted products.

`GET /api/rollback` is a separate read-only planning step so a confirmation screen can show exactly
what will and won't be touched. A test caught it returning another shop's plan with a 200 — it now
404s indistinguishably, since the body would otherwise leak both that the id is real and the
destination product ids inside it.

## 2.5 — Scheduled/recurring sync (`2bda58b`)

`ScheduledSync` model, `app/lib/scheduler.server.js`, CRUD at `/api/scheduled-sync`, tick at
`/api/scheduler-tick`. See decision #2 above for the deployment requirement.

`computeNextRun()` is pure and exhaustively tested, including the case that matters most: it always
returns a time **strictly** in the future. Returning "now" when a schedule fires exactly on its slot
would make it re-fire on every subsequent tick.

Two failure modes handled explicitly, because both otherwise become silent runaways:
- **Overlap** — previous job still running when the next slot arrives: the slot is skipped rather than
  starting a second job writing to the same store pair concurrently.
- **Expiring credentials** — offline tokens expire (the app sets `expiringOfflineAccessTokens: true`).
  Three consecutive failures disable the schedule with an actionable reason; a recognized 401/403
  disables immediately rather than burning the retry budget on something that will never self-heal.
  Re-enabling clears the failure streak *and* refreshes the stored token from the live session —
  otherwise one more failure would instantly re-disable it.

The CRUD surface never returns token columns in any response.

## Notes for Phase 3 (not acted on)

Surfaced while working, deliberately left for the security phase:
- `encrypt()` in `app/utils/encryption.server.js` **silently passes plaintext through** when
  `ENCRYPTION_KEY` is unset (it warns to console and returns the input). Every token in `SourceStore`,
  `TransferSession`, `MigrationJob` and now `ScheduledSync` is affected. Directly relevant to Phase 3's
  "OAuth token storage encrypted at rest (verify Prisma/SQLite field-level encryption, not plaintext)".
  A test now sets a key explicitly so the at-rest assertion is meaningful.
- `/api/scheduler-tick` is the app's only endpoint not behind Shopify admin auth. It's guarded by a
  constant-time secret comparison and fails closed, but it's worth a look during the security pass.
- Phase 3's "rate-limit / abuse protection on your own API endpoints" now has more surface to cover —
  backup/restore, rollback and preview are all newly reachable and non-trivial to run.

## Files added in Phase 2

**Libraries:** `transfer-log.server.js`, `backup.server.js`, `transfer-diff.server.js`,
`rollback.server.js`, `scheduler.server.js` (each with a co-located `.test.js`)

**Routes:** `api.backup.jsx`, `api.transfer-preview.jsx`, `api.rollback.jsx`,
`api.scheduled-sync.jsx`, `api.scheduler-tick.jsx` (each with a `test/routes/` test)

**Migrations:** `add_transfer_log_entry`, `add_store_backup`, `add_rollback_support`,
`add_scheduled_sync` — all additive; the one column added to an existing table
(`ProductMapping.action`) defaults to the safe `"unknown"`.

**Modified:** `migration-worker.server.js` (backup gating, action tracking, per-record logging),
`api.migration-status.$jobId.jsx` (log surfacing), `test-helpers.js` (POST default),
`.eslintrc.cjs` (Node env for tests)

---

# PHASE 1 — Core Hardening (complete, deployed)

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

## Post-Phase-1 fix: productCreate sending options/variants directly on ProductInput

**Commit:** `82c6720` (on `main`)

Another bug found via manual production testing (separate from the giftCard fix above, which was
confirmed working). Error: `Variable $input of type ProductInput! was provided invalid value for
options (Field is not defined on ProductInput), variants (Field is not defined on ProductInput)`.

Verified against shopify.dev's GraphQL reference for the pinned API version (2025-10) rather than
guessing: `ProductInput` has neither field; `productCreate`'s `input: ProductInput` argument is
deprecated in favor of `product: ProductCreateInput`, which has `productOptions` but still no
`variants` — productCreate only ever creates a single initial variant. Multi-variant products need a
follow-up `productVariantsBulkCreate(productId, variants, strategy: REMOVE_STANDALONE_VARIANT)` call,
whose `ProductVariantsBulkInput` nests `sku`/`requiresShipping`/`weight` under `inventoryItem` rather
than directly on the variant.

This exact bug existed in three places (all building the same deprecated shape): `migration-worker.server.js`,
`app.transfer.jsx`, and `app.product-importer.jsx`. Extracted the corrected two-mutation flow into a
shared, unit-tested `app/lib/product-variants.server.js` instead of fixing it three times separately, and
wired all three call sites through it. 14 new unit tests for the shared module, plus a targeted
multi-variant integration test added to each call site's existing suite asserting the actual mutation
payloads sent are well-formed (no bare `options`/`variants` field; correct `productOptions`/
`optionValues`/`inventoryItem` nesting).

`productUpdate`'s `input: ProductInput` path (conflictMode=overwrite) is unaffected — it never set
options/variants, and the fields it does use (title, descriptionHtml, vendor, productType, tags) still
exist on `ProductInput`. It uses the same deprecated argument name as productCreate, which is a
lower-priority modernization note, not a live bug — left as-is.

---

## Post-Phase-1 investigation: reported metafields regression — not reproduced

**Commit:** `b364ed2` (on `main`)

Reported: after the productCreate/productVariantsBulkCreate split above, metafields stopped copying to
newly created products (repro: a product with a "Material: Cotton" metafield created correctly, but
with no metafield on the destination).

Checked whether the refactor dropped the `copyMetafields`/`copyGraphqlMetafields` call. It did not —
both `migration-worker.server.js` and `app.transfer.jsx` still call it after product+variant creation,
threaded with the correct destination GID, unchanged from before the refactor. Independently
re-verified `MetafieldsSetInput`'s schema against shopify.dev too (ownerId/namespace/key/value/type —
unchanged). Added regression tests reproducing the exact scenario (multi-variant product + a real
metafield value) for both files; both pass, meaning the call sequence and GID threading are correct in
this test harness.

Since both functions silently swallow internal failures into a `console.warn` rather than surfacing
them in the transfer's visible error log, if this is still reproducing the fastest path to the real
cause is the server console log line itself (`[migration-worker] copyMetafields failed: ...` or
app.transfer.jsx's equivalent warning) — that message carries whatever Shopify API error is being
swallowed, which isn't something static analysis or a mocked test can surface if it's data- or
environment-specific. Reported this back rather than inventing an unverifiable fix.

---

## Post-Phase-1 fix: the actual root cause of the metafields regression

**Commit:** `703774b` (on `main`)

No live Shopify test-store credentials exist anywhere in this repo/env (`.env` only has
`DATABASE_URL`) — could not run a live reproduction as requested. Found the real bug instead by
comparing migration-worker.server.js's `copyMetafields` against app.transfer.jsx's
`copyGraphqlMetafields` line by line, since the two are meant to be kept in sync manually.

**Root cause:** `copyMetafields` called the `metafieldsSet` mutation via
`await shopifyGraphql(...)` and discarded the result completely — never read it at all.
`shopifyGraphql` only throws on HTTP failures or a top-level GraphQL `errors` array; a mutation
returning HTTP 200 with a non-empty `userErrors` array (Shopify rejecting a value/type, a permission
issue, etc.) is a normal, non-exceptional response. So a rejected metafield was silently treated as
success — not even a `console.warn` fired, because nothing was catching it. This is exactly
"product creates fine, metafield isn't there, no error anywhere."

app.transfer.jsx's `copyGraphqlMetafields` already checked `userErrors` correctly and surfaced them
into the user-visible `warnings` array — this bug was specific to migration-worker.server.js's copy,
which had drifted from its "mirror" during some earlier edit.

**Fix:** `copyMetafields` now checks `userErrors` and returns `{ copied, errors }`, each error
carrying Shopify's message/field/code plus a truncated (200-char) snapshot of the exact metafield
payload sent. These propagate up through `transferOneProduct` into `runMigrationWorker`, which pushes
them into the job's existing `errorLog` (tagged `type: "metafield"` with source/dest product IDs) —
already exposed by `GET /api/migration-status/:jobId` and persisted on `MigrationJob`, so retrievable
after the fact via the API or a DB query, satisfying the "store in the job's DB record" ask without a
schema migration. A metafield failure still doesn't fail the product transfer itself.
app.transfer.jsx's already-correct path gained the same payload-snapshot detail for parity.

Regression tests added for both files: mock `metafieldsSet` returning a valid 200 OK with non-empty
`userErrors`, assert the product still completes successfully AND the failure is retrievable with the
Shopify error text/code/payload. These tests would have silently passed (caught nothing) against the
old code.

---

---

# Next step

**Phase 3 is done — all 7 PRD items — except item 3.1, which is implemented but deliberately
uncommitted awaiting your explicit review** (it changes token storage). Phase 4 has not been started.

Blocking on you, in priority order:

1. **react-router RCE** — upgrade is verified and waiting on branch `fix-rce-upgrade`. Deploy to
   staging, then merge. Highest-severity open issue.
2. **Migration chain can't build a fresh database** (decision #3) — breaks any rebuild or new
   environment. Needs a call on how to repair the history.
3. **Review + commit item 3.1** (token encryption). Confirm production `ENCRYPTION_KEY` is set and
   ≥32 chars first, or the fail-closed behavior will break token writes on deploy.
4. **Deploy timing for the scope change** (`dd4cbe4`) — it triggers merchant re-authorization.
5. `read_customers` vs privacy-policy wording — decision #5.

Still open from Phase 2 (unchanged): `backupPolicy` default, `SCHEDULER_SECRET` + cron, and the
5000-product backup ceiling.
