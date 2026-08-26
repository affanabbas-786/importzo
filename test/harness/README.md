# ThemeJob offline verification harness

Drives `app/lib/theme-worker.server.js` end to end against a fake Shopify, to
prove the two properties that unit tests cannot: that an interrupted transfer
**resumes** without redoing work, and that resuming **never creates a second
theme**.

```bash
bash test/harness/run.sh
```

First run generates a self-signed cert and a throwaway SQLite database; both are
gitignored. Everything is offline — **no real store and no real database is ever
touched.**

## Why it is built this way

`global.fetch` is deliberately *not* stubbed. Two real HTTPS servers stand in for
the source and destination stores, so `shopifyFetch`'s retry, pacing and
per-shop concurrency cap all stay in the path, and asset staging happens on a
real disk.

More importantly, the worker runs in a **separate child process** that is killed
with a real `SIGKILL`. That is what makes the interruption faithful to the PM2
restart this recovery path exists for: no unwinding, no `finally`, no terminal
status write. An in-process abort would tear down cleanly and prove nothing.

Isolation comes from three redirections, all in `lib.mjs`: `DATABASE_URL` points
at `harness.sqlite` (never a name matching `/production/i` — `database-guard.js`
enforces that), `TMPDIR` is redirected so theme staging and ZIPs land here, and
tokens are injected so the worker never reaches `shopify.server.js`.

## The scenarios

**1 — full run.** The whole phase machine, LISTING→EXTRACTING. Checks each asset
is fetched exactly once, that exactly one unpublished theme is created under the
snapshotted name, that EXTRACTING really polls until `processing` clears, and
that the ZIP and staging directory are gone afterwards.

**2 — SIGKILL mid-FETCHING.** Kills the child partway through a 40-asset theme,
asserts the row is left exactly as a crash leaves it (`RUNNING`/`FETCHING`, a
half-full staging directory), then resumes and asserts **nothing already staged
is re-downloaded** and exactly the remainder is fetched.

> Resume is driven by **disk staging, not the DB counter**: `assetsFetched` is
> still 0 at kill time, because the checkpoint only fires every 25 assets.

**3 — the adoption guard**, both ways in.
*3a* reproduces the one genuinely dangerous window: the fake store registers the
theme and then **never answers**, so the child can be killed at the exact moment
Shopify has created a theme the job does not yet know the id of. The resume must
adopt that orphan — not create a second one — and consume exactly one usage
record in total.
*3b* is a plain re-submit against a destination that already has a theme of that
name: adopted at LISTING, zero assets downloaded, zero usage consumed.

## Adding a scenario

`run.sh` globs `scenario-*.mjs`, so a new file is picked up automatically. Each
one is expected to print its own PASS/FAIL lines and exit non-zero on failure.
