# Importzo — Founder Audit

**Date:** 2026-08-15
**Scope:** Auth/token handling, billing, full application review, data integrity, security, polish
**Build state at completion:** 1035 tests passing (baseline 1012), build clean, PM2 online, boot clean

---

## Bottom line

The app is in **good** shape structurally and **better than expected** on the things that usually rot: GDPR erasure is genuinely complete (verified by execution, not by reading code), encryption is real rather than decorative, rate limiting and throttle-awareness are properly implemented, and there is not a single `TODO`/`FIXME`/`HACK` or piece of placeholder copy in shipped code.

Three findings mattered enough to change my assessment:

1. **A silent catalog-duplication bug in the core import flow** — the single highest-stakes defect possible in this product. Fixed, in both copies.
2. **Live merchant access tokens committed to git.** Remediated (sessions rotated for all 5 affected shops); history purge still outstanding.
3. **A leaked `SCHEDULER_SECRET`** in a committed Claude Code settings file. Rotated and verified.

The recurring theme is not bad code. It is **failure modes that resolve silently in the unsafe direction** — a swallowed exception that becomes a duplicate, a background job that stops with nobody watching, an env var added but never loaded. The code is well-reasoned and unusually well-commented; what it lacked was noise when things go wrong.

---

## Data-loss / corruption risk in the core import flow

This is the section that matters most, so it goes first.

### Risk before this audit: **MODERATE-HIGH**, driven by one specific bug

`findProductByHandle` — the conflict-detection lookup that decides whether a product already exists on the destination — swallowed **every** error and returned `null`. The caller reads `null` as *"nothing there, safe to create."*

So any transient failure silently downgraded `conflictMode: "skip"` and `"overwrite"` into `"create"`:

- a 429 that outlived the five retries in `shopify-api.server.js`
- any 5xx from the destination store
- a dropped connection
- an expired access token (very likely — see the token-lifetime work below)

The merchant who selected "skip" selected it **precisely so a re-run would not duplicate their catalog**. And a re-run — after an interruption, a timeout, a resume — is exactly when a transient error is most likely. The failure was completely silent: no error, no log line, no failed row. A merchant would discover it by finding duplicate products in a live store days later, with nothing to explain them.

This existed in **two** places: the async worker and the synchronous transfer path.

**Fixed.** The lookup now distinguishes "Shopify says no such handle" from "could not find out". When it cannot find out, the product **fails** — visible in the job log, retryable, and it changes nothing on the destination. A failed row is recoverable; a duplicate has to be cleaned out of a live store by hand.

### Risk after: **LOW**, with a caveat

What is genuinely good, and I verified rather than assumed:

- **Resume is real.** The worker reads `lastCursor` plus `ProductMapping.status = DONE` and skips completed work. `ProductMapping` is `@@unique([jobId, sourceProductId])` and written via `upsert`.
- **Pre-transfer backup defaults to `require`** — a failed snapshot aborts before any write rather than running an irreversible transfer with no way back. Partial snapshots are explicitly flagged as partial.
- **Rollback is conservative.** It only deletes rows provably `action: "created"`, so a `skipped` product (the merchant's own pre-existing data) is never touched by an undo.
- **Rate limits are respected**, not fired blindly: 429 backoff honouring `Retry-After`, plus pre-emptive slowdown from the GraphQL cost-extension throttle bucket.
- **Token expiry mid-job is handled.** Tokens are re-resolved before every batch and a 401 is treated as a job-level problem (refresh and retry the product) rather than being recorded as "this product could not be transferred".

**The caveat:** the *destination-side* guarantee is only as strong as conflict detection, which is a `handle` lookup. If a merchant's source catalog contains two products with the same handle, or the destination has a product whose handle differs but which is semantically the same item, the app will not catch it. That is inherent to handle-based matching and is a product decision, not a bug — but it is the remaining sharp edge.

---

## Issues found and fixed

### Critical

**1. Conflict detection failed open into catalog duplication**
`app/lib/migration-worker.server.js:189-217` (was `:189-198`)
`app/routes/app.transfer.jsx:299-322` (was `:299-311`)
Call sites: `app/lib/migration-worker.server.js:243-256`, `app/routes/app.transfer.jsx:371-384`
Both copies now return `{ ok, product }` and the caller refuses to create when the answer is unknown. 4 regression tests covering 500, 401, the definitive-not-found path, and `conflictMode: "create"` bypass.

**2. Live merchant access tokens committed to git**
`.gitignore:56-75`
12 SQLite backups were tracked at `HEAD`; `production.sqlite` was in history. `PrismaSessionStorage` stores `Session.accessToken` in **plaintext** — only the app's own token copies go through `encryption.server.js`. Tokens in `production.sqlite.backup.20260804-1246` were byte-identical to production for 4 shops; a 5th (`motorbike-horse`) matched via `predeploy-20260806-1946`.
Root cause: `.gitignore` matched `prisma/production.sqlite` *exactly*, so every `deploy.sh` backup was committable.
Fixed: globbed ignore rules, `git rm --cached` on all 12 (files intact on disk), `chmod 640` on every SQLite file (they were `664` — world-readable).
Remediated: sessions deleted for all 5 shops so Token Exchange re-mints credentials. Verified 5 deleted, 4 survivors byte-identical, integrity `ok`.
Mitigating: repo is **private**; every leaked access token had **already expired** at Shopify; refresh tokens are unredeemable without `SHOPIFY_API_SECRET`, which has never been committed.

**3. `SCHEDULER_SECRET` committed in `.claude/settings.local.json`**
A previous session's permission allowlist captured `curl` commands with the secret inline (5 entries). Anyone with repo read access could trigger the privileged maintenance endpoint — scheduled syncs, retention purges, job recovery.
Fixed: entries stripped from disk, file untracked (already in `.gitignore`, committed before the rule), **secret rotated**. Verified end-to-end: new secret → 200, old secret → 401.

### High

**4. Orphaned migrations had no server-side recovery**
`app/lib/job-recovery.server.js` (new), `app/routes/api.scheduler-tick.jsx:17-18,96-110`, `app/routes/api.migration-status.$jobId.jsx:57`
`runMigrationWorker` is fire-and-forget, so a PM2 restart killed every in-flight worker while the row stayed `RUNNING` forever. The **only** resume path required a merchant to be actively polling — no recovery at all for a closed tab (the entire reason the background worker exists), a scheduled sync (no browser, ever), or a returning merchant staring at a progress bar frozen at 40% with no error.
`PENDING` had the same hole one step earlier: the row is created before the worker is called, and auto-resume only tested for `RUNNING`.
PM2 shows 7 restarts on this app.
Fixed: recovery runs on the 15-minute cron tick — resumes `RUNNING` quiet >15min and `PENDING` >5min, skips anything active in-process, caps at 3 resumes/tick, and fails jobs interrupted >24h with merchant-readable copy rather than retrying forever. 13 unit tests + 3 route tests. **Confirmed live** in the tick response.

**5. Double-submit created two concurrent jobs over the same catalog**
`app/routes/api.migration-job.jsx:74-100`
`maxConcurrent` is 2 (two *different* source stores at once is legitimate), so a double-clicked button passed the load cap at `1 < 2`. Two workers then ran the identical product set: `ProductMapping` is unique per `(jobId, sourceProductId)` so it dedupes *within* a job and not across two, and `conflictMode: "skip"` loses the race because both look up the handle before either has created anything.
Fixed: an in-flight job for the same source→destination pair short-circuits and returns the existing `jobId` with `alreadyRunning: true`, so a double-click just polls the real job. 4 tests, including that a different source store is still allowed.

### Medium

**6. Malformed source data silently vanished**
`app/lib/migration-worker.server.js:614-632`
A source product with no id was dropped by a bare `return` — counted as neither processed nor failed, with no log entry and no console line. A merchant comparing catalogs afterwards would find something missing and have nothing to explain it. Now fails loudly with a merchant-readable reason.

**7. Billed feature dead in production with no signal**
`app/shopify.server.js:21-40`
`GROQ_API_KEY` was added to `.env` on 2026-08-13; the process had started 2026-08-12. Built-in AI is advertised as an included Pro/Agency feature (`billing-ui.js:203`), and it threw on every call for two days while the app looked perfectly healthy. Added a boot-time warning (deliberately a warning, not a throw — BYOK still works and refusing to boot over an optional credential would take migrations down). The restart at the end of this audit cleared the underlying condition; the absence of the warning in the boot log is now the proof.

**8. Credential metadata in logs**
`app/routes/app.transfer.jsx:1443-1449, 1723-1724`
Logged `tokenLen` and `tokenPrefix` for source-store tokens. The prefix was harmless in practice (always the literal `shpat_`), but length plus prefix is credential metadata written to a log file for no operational benefit. Now logs presence only.

**9. World-readable production database**
`production.sqlite` and all backups were `664`. The directory chain (`770`) blocked traversal, so not directly exploitable — but this is the same class as the Citeable finding. Now `640`.

### Low

**10. 916 KB favicon**
`public/favicon.ico` was not an ICO at all — a **6250×6250 PNG** at print resolution, decoded by every browser for a 16px tab icon, on the public marketing page.
Losslessly optimised all public PNGs (no resize tooling available; see flagged items): **697 KB saved**, pixel-identical, dimensions unchanged.
- `favicon.ico` 916,163 → 267,294 b (−71%)
- `og-image.png` 83,524 → 57,172 b
- `favicon.png` 282,846 → 269,013 b
- `logo.png` 68,304 → 60,276 b

---

## Verified clean — no action needed

These were checked properly and are genuinely fine. Recorded so they don't get re-audited.

**Auth (the Citeable bug class is absent):**
- Token Exchange is the only auth path. `@shopify/shopify-app-react-router@1.2.1` ships only `strategies/token-exchange.js` and `merchant-custom-app.js` — the legacy authorization-code strategy does not exist in this version. No `/auth/callback` route. The `redirect_urls` entry in `shopify.app.toml` is vestigial config, not a reachable path.
- Refresh tokens **are** persisted (all sessions have `refreshToken` + `refreshTokenExpires` ~90 days out).
- Expiry **is** checked before use, and the fix is real rather than inert. Traced into the library: `unauthenticated.admin()` → `ensureValidOfflineSession` → `ensureOfflineTokenIsNotExpired`, which refreshes within 5 minutes of expiry and writes back via `storeSession`. Both preconditions hold (`expiringOfflineAccessTokens: true`, `distribution: AppStore`).

**Billing:**
- **No `FORCE_TEST_CHARGES` equivalent.** PM2 `module_conf.json` contains only `{"citeable": {}}` — nothing for Importzo. No test/bypass flag in `.env`, the ecosystem config, or the live process environment.
- `isTestCharge` is derived from Shopify's own `shop.plan.partnerDevelopment`, **not** `NODE_ENV`, and fails closed to a real charge. This is the correct direction: a real charge against a dev store is declined by Shopify, whereas a test charge against a real store is silent free service.
- Plan state is read back from Shopify via `billing.check()` on every Billing page load, plus the `app_subscriptions/update` webhook. Tier is never taken from a URL parameter.
- Plan gates are enforced **server-side**: quota in the worker and 5 import routes, scheduled sync gated with 403 at both creation and re-enable *and* re-checked on every tick so a downgrade takes effect immediately.

**GDPR erasure — verified by execution against the deployed schema, 14/14 checks passed.**
I seeded a row in all 12 shop-scoped tables for two shops in a scratch copy of the real schema, then ran the actual handler code. Result: all 12 tables emptied for the redacted shop, **zero per-model errors**, bystander shop completely untouched, `actorEmail` gone with `TransferLogEntry`, and `TransferSession` correctly erased via `sourceShop`/`destShop` (the past regression). No `Customer*` model exists, so the no-op `customers/*` handlers are honest. Every model in the deployed schema is wired into erasure.

**Security:**
- Encryption is **live, not inert** (the Citeable failure): versioned `v2:` format, random IV per call, non-deterministic output, round-trips correctly, throws without a key.
- No world-writable files anywhere in the deploy path.
- No `.env` file has *ever* been committed (only `.env.development.example`, which carries no secrets). No `.env` value appears in any tracked file after the `SCHEDULER_SECRET` fix.
- Webhooks reject unsigned POSTs (400 across all 5). Scheduler tick rejects absent/bad secrets (401). Another shop's job id is not readable (410).
- Rate limiting active with per-operation policies and concurrency caps.

**Scheduler reliability:** the cron is real and healthy — `*/15 * * * *`, exit 0, HTTP 200. The script reads the secret from `.env` at runtime (not from the crontab, not from argv) and only writes to the log on failure, so the 12-day silence was success, not a silent failure. Verified by running it.

**Polish:** zero `TODO`/`FIXME`/`HACK`/`XXX` in shipped code. No placeholder copy. Logging is structured operational output with consistent prefixes, not debug residue.

---

## Flagged for your decision

**1. Git history purge (BFG / git-filter-repo)** — agreed as a separate task. The DB backups and the old `SCHEDULER_SECRET` are still in history. Both leaked values are now inert (sessions rotated, secret rotated), so this is cleanup rather than active risk.

**2. `SHOPIFY_API_SECRET` rotation — target 2026-08-22.** Decisively kills every leaked refresh token, including any in backups not enumerated. Needs a downtime window: webhook HMAC verification breaks until `.env` is updated and PM2 restarts, and the value must change in the Partner Dashboard and `.env` in sync. Saved to memory.

**3. API version is 3 releases behind.** `shopify.server.js` pins `ApiVersion.October25` (2025-10); the SDK offers `2026-01` and `2026-04`. Support for 2025-10 lapses around Oct 2026. This app has *already* had jobs die on `Field 'giftCard' doesn't exist` when a version moved, so this is a scheduled outage. Needs live-store testing, so I flagged rather than bumped. Related: `shopify.app.toml` declares `webhooks.api_version = "2026-04"` while the app code runs 2025-10 — an inconsistency worth resolving in the same pass.

**4. Favicon still needs a real resize.** 267 KB is a 71% improvement but still ~50× larger than it should be. Correct fix is a true multi-resolution ICO (16/32/48) and a 180×180 apple-touch PNG — roughly 5–10 KB total. **No resize tooling is installed** (only `optipng`, which cannot resize), and installing ImageMagick on your production VPS or adding an image dependency to `package.json` is your call, not mine. Same for `myfonts.ttf` (345 KB, preloaded) → WOFF2 would be ~40% the size.

**5. `read_customers` scope vs. the published privacy policy.** Pre-existing and already noted in `shopify.app.toml`, repeated here because it is a legal-copy question and therefore explicitly yours: the policy says the app does not collect customer personal information — true, since the export streams to the browser and is never persisted — but it sits awkwardly beside a feature that reads names, emails and phone numbers, and it is Shopify protected customer data requiring separate approval.

**6. `read_markets` scope is still uncommitted.** Adding it triggers a re-authorization prompt for every existing install. Held for your explicit go-ahead, per the existing note.

**7. The app runs as `root` under PM2.** Not exploited and not novel, but it means any RCE is an immediate full-host compromise, and it is why the `640` database permissions are defence-in-depth rather than a real boundary. Moving to a dedicated service user is a meaningful operational change.

**8. Three dead functions in `app/transfer.jsx`** (`pagePayloadFromSource`, `blogPayloadFromSource`, `articlePayloadFromSource`) flagged by eslint as unused. Left in place — they may be staged for a feature, and I would rather ask than delete code from a 3,800-line route. All 6 eslint errors in that file are pre-existing; none were introduced by this audit.

---

## Could not check

**Partner Dashboard Monitoring/Logs tab.** No credentials or browser access in this environment; the Shopify CLI here reads local config only. You will need to check that tab yourself for deprecation / "fix overdue" flags. The API-version finding above is the code-side equivalent and is the most likely thing such a flag would be about.

**Whether anyone ever read the leaked tokens.** Nothing in the app can answer this. GitHub's repo audit log is the only source.

**That the old tokens are revoked at Shopify.** Deleting our session rows deletes *our copy* — it sends nothing to Shopify and triggers no revocation. The expiry timestamps we read back (all already past) are Shopify's own record, not a live probe. Directly testing revocation would mean using a leaked credential against a real merchant's store, which is the thing being remediated.

---

## Verification at completion

| Check | Result |
|---|---|
| Test suite | **1035 passed** (baseline 1012, +23) |
| Lint on changed files | No new errors (6 pre-existing in `app.transfer.jsx`, unchanged) |
| Prisma migrations | 17/17 applied, 0 pending, 0 failed |
| Build | Clean |
| PM2 | `online`, 0 unstable restarts, 117 MB |
| Boot log | `shopify-api 13.1.0`, `react-router-serve` up, no FATAL, no GROQ warning |
| Public routes | `/` `/privacy` `/auth/login` → 200; `/app` → 410 (correct auth boundary) |
| Webhook HMAC | 400 on all 5 unsigned POSTs |
| Scheduler tick | 200 with rotated secret; 401 with old secret |
| Job recovery | Live — `recovery` block present in tick response |
| Database | 4 sessions, `integrity_check: ok` |

Backups taken before mutating anything: `prisma/production.sqlite.backup.pre-token-rotation-20260815-1556` (via `sqlite3 .backup`, WAL-consistent, verified 9/9 rows before the delete), plus `.env` and `settings.local.json` copies in the session scratchpad.

---

## Three process defects in `deploy.sh`

I read `deploy.sh` at the end and it explains more than it looks like it should. It currently runs: `npm run build` → `npx prisma migrate deploy` → `pm2 reload importzo`.

**1. `pm2 reload importzo` does not pick up `.env` changes — this is the actual root cause of finding #7.**
PM2 injects the environment it cached in `dump.pm2` at first start, and Node's `--env-file` does not override variables already present in the process environment. So a deploy after editing `.env` silently keeps serving the *old* values. That is exactly how `GROQ_API_KEY` could be added on 2026-08-13 and still be absent from a process that had been reloaded since. It will happen again with any new variable.
**Fix:** `pm2 reload ecosystem.importzo.config.cjs --update-env`, which re-evaluates the config (re-running `dotenv.parse` against the current `.env`). That is what I used for this audit's restart, and it is why the rotated `SCHEDULER_SECRET` took effect.

**2. `prisma generate` is missing.** The documented order is generate → migrate deploy → build → reload. Without `generate`, a schema change deploys against a stale client.

**3. `prisma migrate deploy` will fail while the app is running.** SQLite returns `database is locked` — I hit this during the audit. It happened to be harmless because all 17 migrations were already applied, but on a deploy that *does* carry a migration, `set -e` means the script aborts **after** `npm run build` and **before** `pm2 reload` — leaving new code built but not serving, and the migration unapplied. Needs the app stopped for the migration step, or a retry/backoff.

**One more, unrelated to `deploy.sh`:** the first backup I took during this audit with `cp -a` captured **8 of 9 sessions** — it missed the write-ahead log. Anything that copies a live SQLite file with `cp` produces a silently incomplete backup. Use `sqlite3 production.sqlite ".backup 'target'"`, which is what I used for the real one. `deploy.sh` does not back up the database at all, so whatever produced the fourteen `production.sqlite.backup.*` files is a separate process worth checking for the same flaw.

I did not modify `deploy.sh` — it is your deploy path and changing it mid-audit without you watching is not a call I should make unilaterally.
