# Importzo — Product Requirements Document & Growth Plan
**Owner:** Affan Abbas (Dazzle Tech LLC)
**Prepared:** July 2026
**Objective:** Reposition Importzo as a dual-capability Shopify app (bulk import/export + store clone/migration), harden it technically, and execute a path to category leadership (#1 in Store Data Importer).

---

## 1. Strategic Decision: Dual Positioning (Confirmed)

Audit findings support running **both** capabilities under one app, not choosing one:

| Capability | Competing Against | Competitive Density | Reviews Needed to Compete |
|---|---|---|---|
| Bulk CSV/Excel import-export, inventory sync | Matrixify (1,332 reviews, 4.9★, BFS badge) | Extremely high | Unrealistic to out-rank directly in <12 months |
| Store clone / migration / staging / multi-store | Duplify, Store Clone, Clonely, Quick Store Copy, CopyCat | Low-moderate — no dominant leader (best competitor: 4.0★, 2 reviews) | Winnable within 2-3 months of active reviews |

**Decision:** Lead the App Store listing, marketing, and SEO with **clone/migration** (winnable lane, real merchant demand — multi-store brands, regional expansion, staging, backups). Keep **import/export (Matrixify-style)** as a secondary, fully-built capability inside the same app — this becomes your expansion/upsell surface once users are in the door via clone/migration. Do NOT market both with equal weight; you'll dilute positioning and confuse App Store SEO matching.

**Rationale tied to your situation:** You already run 5 brands (Citeable, Importzo, Asaanweb, Hilya, Anas Autos, university side-projects) — multi-store/multi-brand is a lived use case you understand better than most competitors, which is a real credibility asset for marketing copy and case studies.

---

## 2. Feature Roadmap

### Phase 1 — Core Hardening (Weeks 1-3)
Non-negotiable before any marketing push. An app with 0 reviews and bugs will get 1★ reviews that kill BFS eligibility permanently.

- [ ] Full regression test of existing clone/migration flow (products, themes, media, pages, blogs, menus, metafields)
- [ ] Full regression test of import/export flow (CSV/Excel bulk product import, matching Matrixify's core column mapping conventions so switchers feel at home)
- [ ] Idempotency: re-running a transfer must not duplicate data
- [ ] Rate-limit handling against Shopify Admin API (429 backoff + queue retry)
- [ ] Large file support: streaming upload/parse instead of full in-memory load (critical — this is a listed feature claim, must actually hold at 50k+ SKU scale)

### Phase 2 — Trust & Safety Features (Weeks 3-5)
These directly address the #1 blocker for cloning/migration tools: **merchants are terrified of data loss**.

- [ ] **Pre-transfer automatic backup/snapshot** of destination store (products, collections, metafields) before any write operation — restorable with one click
- [ ] **Dry-run / preview mode** — show exactly what will change before committing (diff view: X products will be created, Y updated, Z skipped)
- [ ] **Rollback capability** — undo last transfer within a time window
- [ ] **Detailed transfer logs** — per-record success/failure with reasons (you already have this per listing copy — verify it's genuinely granular, not just a summary count)
- [ ] **Scheduled/recurring sync option** (Matrixify parity feature — recurring exports on a schedule)

### Phase 3 — Security Hardening (Weeks 4-6)
Required both for merchant trust and for Shopify's App Store review + BFS audit.

- [ ] OAuth token storage encrypted at rest (verify Prisma/SQLite field-level encryption, not plaintext)
- [ ] Scope minimization — request only the Shopify API scopes actually used; audit current `read/write` scopes against the privacy policy already published
- [ ] GDPR mandatory webhooks (customers/redact, shop/redact, customers/data_request) — confirm these are implemented and tested, not just declared
- [ ] Rate-limit / abuse protection on your own API endpoints (prevent one shop's runaway job from starving others on shared VPS)
- [ ] Audit logging — who triggered what transfer, when, from which IP
- [ ] Webhook signature verification (HMAC) on all incoming Shopify webhooks
- [ ] Dependency vulnerability scan (`npm audit` / Snyk) as part of CI before each deploy

### Phase 4 — Differentiation Features (Weeks 6-8)
What makes Importzo genuinely better than existing small competitors:

- [ ] Cross-platform import (WooCommerce → Shopify) — you already have deep WooCommerce experience (anasautos.com, kngreenenergy.pk) — this is a real moat competitors like Duplify/Store Clone don't emphasize
- [ ] Markets/multi-currency aware transfer (filter by region — Store Clone app markets this; match or beat it)
- [ ] Field-mapping templates saved/reusable (saves repeat-migration merchants time)
- [ ] AI-assisted product data cleanup during import (SEO title/description generation) — direct synergy with your Citeable/GEO expertise, and matches what "Importo" (competitor) already advertises

---

## 3. Pricing Plans (tie-in from earlier discussion)

| Plan | Price | Limits | Purpose |
|---|---|---|---|
| Free | $0 | Up to 250 records/month, single store pair, no scheduled sync | Hook — must be usable enough to generate reviews |
| Starter | $19/mo | Up to 5,000 records/month, backup/rollback included | Core paid tier |
| Growth | $49/mo | Unlimited records, scheduled sync, cross-platform import, priority support | Matrixify-parity tier |
| Agency | $99/mo | Multi-store management, white-label reports, API access | For agencies managing multiple client migrations (your own Dazzle Tech use case) |

**Important constraint for BFS:** the 50 net installs required for Built for Shopify must come from **shops on paid Shopify plans**, not free-trial shops. Your app being free-to-install is fine — the requirement is about the *merchant's* Shopify plan tier, not your app's pricing. Don't let this block your free-tier strategy.

---

## 4. Testing Strategy

- **Unit tests**: transfer logic, field mapping, diff engine (target 80%+ coverage on core transfer modules)
- **Integration tests**: against Shopify Admin API using a dedicated dev store, covering full transfer cycles for each data type (products, themes, metafields, etc.)
- **Load testing**: simulate 50k+ SKU transfer to validate large-file-support claim before marketing it further
- **Beta test group**: recruit 10-15 real merchants (Facebook groups, Shopify community forums, r/shopify) for free extended access in exchange for structured feedback + honest review — this is your fastest path to the 5 reviews needed for BFS

---

## 5. PRD for Claude Code Implementation Loop

Structure this as an autonomous agentic loop (`claude --dangerously-skip-permissions`) working through a checklist, with human review gates only at billing/security-sensitive commits, per your existing workflow preference.

**Repo structure assumption:** Node.js/Express + Prisma/SQLite + React/Vite + Shopify Polaris (existing stack)

**Loop instructions to give Claude Code (paste as CLAUDE.md or initial prompt):**

```
You are implementing hardening and feature work on Importzo, a Shopify app for
store clone/migration and bulk data import/export.

Work through PHASE 1 → PHASE 2 → PHASE 3 → PHASE 4 in order from the PRD below.
For each task:
1. Write the implementation
2. Write or update tests covering it
3. Run the full test suite
4. If tests pass, commit with a descriptive message
5. If the task touches billing, OAuth, or webhook signature verification,
   STOP and flag for human review before committing — do not auto-commit
   security-sensitive changes.
6. Move to the next task only after current task's tests pass.

Do not skip Phase 1 items even if they seem redundant with existing code —
verify by testing, not by reading code and assuming it works.

Log progress after each task in PROGRESS.md with: task, status, files changed,
test results.
```

**Sequencing rationale:** security and backup/rollback features (Phase 2-3) must ship before any review-generation push (Section 6) — a merchant who loses data during your beta test will leave a 1★ review that's very hard to recover from and can permanently block BFS eligibility.

---

## 6. Path to #1 — Execution Timeline

| Week | Action |
|---|---|
| 1-3 | Phase 1 hardening (Claude Code loop) |
| 3-5 | Phase 2 trust/safety features |
| 4-6 | Phase 3 security (parallel with Phase 2 tail end) |
| 5 | Rewrite App Store listing: title, description, screenshots emphasizing clone/migration + backup safety (per Section 1 positioning) |
| 6 | Recruit 10-15 beta merchants for free access + review ask |
| 6-8 | Phase 4 differentiation features |
| 8 | Apply for Built for Shopify once 50 paid-plan installs + 5 reviews + rating threshold are met |
| 8+ | Content/SEO push (targeted "clone shopify store," "duplicate store app," "shopify store migration" keywords) + direct outreach to Matrixify/Store Clone negative reviewers |

**Definition of "#1":** realistically targeted as **top 3 in "Store Data Importer" category with clone/migration positioning** within 4-6 months, not literal #1 above Matrixify (different use case, unrealistic timeline). True #1 in the clone/migration sub-niche specifically is achievable given current competitor weakness (best competitor sits at 2 reviews).

---

## 7. Risk Flags

- **Time conflict**: This plan assumes dedicated weeks of Claude Code loop time. You're simultaneously running Citeable's App Store submission, DM client work, and university (BScB semester 1). Realistic sequencing: finish Citeable's submission first (it's further along and has clearer revenue path via SaaS billing tiers), then run this Importzo plan — don't run both simultaneously with your current bandwidth.
- **Server capacity**: Verify your Hostinger VPS can handle beta-test load (10-15 merchants running real transfers) without affecting Citeable's uptime on the same box.
- **Free tier abuse**: 250 records/month free tier — set hard caps in code, not just UI messaging, to prevent cost overrun on your infra during growth phase.
