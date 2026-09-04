#!/bin/bash
# Importzo — Production Deploy Script
# Usage: bash deploy.sh
#
# Ordering and failure behaviour here are deliberate — see FOUNDER_AUDIT.md
# ("Three process defects in deploy.sh") for the incidents each step prevents.

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

ECOSYSTEM="ecosystem.importzo.config.cjs"
DB="prisma/production.sqlite"
APP_NAME="importzo"
# TEMPORARILY RAISED. There are 15 pre-existing backups on disk (some
# predating this script) plus the one each run creates, so the sane long-term
# value of 10 would delete the oldest on the very first deploy. Every one of
# these files held real merchant data, so they are being reviewed and archived
# out-of-band first. 20 leaves headroom for several deploys before anything is
# pruned at all.
# LOWER THIS BACK TO 10 once the pre-2026-08 backups have been archived.
KEEP_BACKUPS=20

for f in "$ECOSYSTEM" .env "$DB"; do
  [ -e "$f" ] || { echo "FATAL: missing $f — are you in the right directory?" >&2; exit 1; }
done

# `|| true` matters: under `set -o pipefail` a grep that matches nothing exits
# non-zero and would abort the deploy here — before the ${:-} default below
# ever gets a chance to supply one.
APP_URL="$(grep -m1 '^SHOPIFY_APP_URL=' .env | cut -d= -f2- | tr -d '"'"'"'' || true)"
APP_URL="${APP_URL:-https://importzo.dazzletech.co}"

# ── Backup ───────────────────────────────────────────────────────────────
# sqlite3 ".backup", never `cp`. The database runs in WAL mode, so a plain
# copy captures the main file WITHOUT the write-ahead log and silently loses
# whatever has not been checkpointed yet. That is not theoretical: a `cp -a`
# backup taken during the 2026-08-15 audit captured 8 of 9 live sessions.
# ".backup" takes a consistent snapshot including WAL content, and works
# safely against a running app.
backup_db() {
  local target="$DB.backup.$(date +%Y%m%d-%H%M%S)"
  echo "==> Backing up database -> $target"
  sqlite3 "$DB" ".backup '$target'"
  chmod 640 "$target"

  # A backup nobody verified is a backup nobody has.
  if ! sqlite3 "$target" "PRAGMA integrity_check;" | grep -qx "ok"; then
    echo "FATAL: backup failed integrity_check — aborting before touching anything" >&2
    exit 1
  fi
  local live copy
  live="$(sqlite3 "file:$DB?mode=ro" "SELECT COUNT(*) FROM Session;" 2>/dev/null || echo "?")"
  copy="$(sqlite3 "$target" "SELECT COUNT(*) FROM Session;" 2>/dev/null || echo "?")"
  echo "    integrity ok; sessions live=$live backup=$copy"
  BACKUP_PATH="$target"
}

# Read into an array rather than piping `ls`. With `set -euo pipefail`, an
# `ls` over a glob that matches nothing exits non-zero and kills the whole
# deploy — verified, it exits 2. That would never fire on a normal run (a
# backup is always taken first) but would on a fresh install, which is
# precisely when a deploy script failing is least welcome.
prune_backups() {
  # The -shm/-wal filter is load-bearing. Opening a backup with sqlite3 (even
  # just to read it) leaves sidecar files next to it, and the glob matches
  # those too — the live directory currently holds 39 matches for ~14 real
  # backups. Counting sidecars as backups would delete genuine ones while
  # keeping orphaned sidecars.
  local -a all=()
  while IFS= read -r line; do all+=("$line"); done \
    < <(ls -1t "$DB".backup.* 2>/dev/null | grep -Ev -- '-(shm|wal)$' || true)
  local total=${#all[@]}
  [ "$total" -gt "$KEEP_BACKUPS" ] || return 0
  echo "==> Pruning $((total - KEEP_BACKUPS)) old backup(s), keeping newest $KEEP_BACKUPS"
  local f
  for f in "${all[@]:$KEEP_BACKUPS}"; do
    rm -f "$f" "$f-shm" "$f-wal"   # take each backup's sidecars with it
  done
}

# ── 1. Prisma client ─────────────────────────────────────────────────────
# Must run BEFORE the build: the build inlines the generated client, so a
# schema change built against a stale client ships the old types.
echo "==> Generating Prisma client..."
npx prisma generate

# ── 2. Build ─────────────────────────────────────────────────────────────
# Safe to do while the old version is still serving — nothing is swapped in
# until the PM2 step below.
echo "==> Building app..."
npm run build

# ── 3. Backup ────────────────────────────────────────────────────────────
backup_db

# ── 4. Migrations ────────────────────────────────────────────────────────
# SQLite gives a single writer. `prisma migrate deploy` against a running app
# returns "database is locked", and because of `set -e` that used to abort the
# script AFTER the build and BEFORE the PM2 step — leaving new code built but
# not serving, and the migration unapplied.
#
# So: only pay for downtime when there is actually a migration to apply.
# `migrate status` exits 0 when the schema is up to date, non-zero when
# anything is pending. Any non-zero result takes the safe path, including
# "could not reach the database" — a false positive costs a few seconds of
# downtime, a false negative would skip a migration.
echo "==> Checking for pending migrations..."
if npx prisma migrate status >/dev/null 2>&1; then
  PENDING=0
  echo "    Schema is up to date — no downtime needed."
else
  PENDING=1
  echo "    Pending migrations found — the app will be stopped to apply them."
fi

if [ "$PENDING" -eq 1 ]; then
  echo "==> Stopping app for migration..."
  pm2 stop "$APP_NAME"

  # Retry anyway: stopping PM2 releases the app's connection, but a WAL
  # checkpoint can still hold the lock briefly on the way down.
  echo "==> Running database migrations..."
  migrated=0
  for attempt in 1 2 3 4 5; do
    if npx prisma migrate deploy; then migrated=1; break; fi
    echo "    attempt $attempt/5 failed (likely 'database is locked') — retrying in $((attempt * 3))s"
    sleep $((attempt * 3))
  done

  if [ "$migrated" -ne 1 ]; then
    echo "FATAL: migrations did not apply after 5 attempts." >&2
    echo "       Restoring service on the PREVIOUS schema; the new build is on disk but unmigrated." >&2
    echo "       Database backup: $BACKUP_PATH" >&2
    pm2 start "$ECOSYSTEM" --update-env || true
    exit 1
  fi

  echo "==> Starting app..."
  pm2 start "$ECOSYSTEM" --update-env
else
  # ── 5. Reload ──────────────────────────────────────────────────────────
  # `pm2 reload <app-name>` does NOT pick up .env changes: PM2 injects the
  # environment it cached at first start, and node's --env-file does not
  # override variables already present in the process env. That is how
  # GROQ_API_KEY sat in .env for two days while the running process — a paid
  # feature behind it — never saw it.
  #
  # Passing the ecosystem FILE re-evaluates the config, which re-runs
  # dotenv.parse against the current .env; --update-env applies the result.
  echo "==> Reloading PM2 with a refreshed environment..."
  pm2 reload "$ECOSYSTEM" --update-env
fi

# ── 6. Verify ────────────────────────────────────────────────────────────
# A deploy that reports success without checking is how a broken deploy gets
# discovered by a merchant instead of by us.
echo "==> Verifying..."
sleep 4

# Same pipefail reasoning: if `pm2 jlist` fails, node parses empty input and
# throws, and an aborted script here would look identical to a healthy one.
# Degrade to a reportable value so the check below can fail loudly instead.
status="$(pm2 jlist 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s).find(x=>x.name==='$APP_NAME');console.log(a?a.pm2_env.status:'missing')}catch{console.log('unreadable')}})" || true)"
status="${status:-unreadable}"
if [ "$status" != "online" ]; then
  echo "FATAL: PM2 reports status='$status' (expected 'online')." >&2
  echo "       pm2 logs $APP_NAME --err --lines 50" >&2
  echo "       Database backup: $BACKUP_PATH" >&2
  exit 1
fi

code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 25 "$APP_URL/" || echo 000)"
if [ "$code" != "200" ]; then
  echo "FATAL: $APP_URL/ returned HTTP $code (expected 200)." >&2
  echo "       pm2 logs $APP_NAME --err --lines 50" >&2
  echo "       Database backup: $BACKUP_PATH" >&2
  exit 1
fi
echo "    PM2 online; $APP_URL/ -> HTTP 200"

# ── 7. Process freshness ─────────────────────────────────────────────────
# The build (step 2) ALWAYS runs before the PM2 step, so a healthy deploy
# leaves the running process started AFTER build/ was last written. If build/
# is newer, the reload silently didn't swap the process and it is serving a
# stale in-memory bundle whose asset manifest no longer matches disk — every
# .css/.js 404s and the UI renders unstyled and dead. That is the 2026-09-01
# outage, which HTTP 200 on / did not catch because / renders without assets.
echo "==> Verifying the running process is not stale..."
proc_started_ms="$(pm2 jlist 2>/dev/null \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s).find(x=>x.name==='$APP_NAME');process.stdout.write(String(a&&a.pm2_env.pm_uptime?a.pm2_env.pm_uptime:0))}catch{process.stdout.write('0')}})" || echo 0)"
proc_started_ms="${proc_started_ms:-0}"
proc_started_s=$(( proc_started_ms / 1000 ))
# Newest mtime anywhere under build/, epoch seconds.
build_mtime="$(find build -type f -printf '%T@\n' 2>/dev/null | cut -d. -f1 | sort -n | tail -1)"
build_mtime="${build_mtime:-0}"
if [ "$proc_started_ms" = "0" ] || [ "$build_mtime" = "0" ]; then
  echo "WARNING: could not compare process start ($proc_started_ms ms) to build mtime ($build_mtime s)." >&2
  echo "         Skipping the staleness check — verify manually." >&2
elif [ "$build_mtime" -gt "$proc_started_s" ]; then
  echo "FATAL: build/ was written $(( build_mtime - proc_started_s ))s AFTER the running process started." >&2
  echo "       The process is serving a stale in-memory bundle against a rewritten build dir." >&2
  echo "       Fix: pm2 restart $APP_NAME --update-env   (build/ is already current)" >&2
  echo "       Database backup: $BACKUP_PATH" >&2
  exit 1
fi
echo "    process started $(( proc_started_s - build_mtime ))s after the last build write"

# ── 8. Asset resolution ──────────────────────────────────────────────────
# Pull the hashed asset URLs the app shell actually references and confirm
# each one is really served. This is the direct check for the failure above,
# and also catches a half-written build/ or a bad asset-serving config.
echo "==> Verifying referenced assets resolve..."
app_html="$(curl -sS --max-time 25 "$APP_URL/app" || true)"
assets="$(printf '%s' "$app_html" | grep -oE '/assets/[A-Za-z0-9_.-]+\.(css|js)' | sort -u || true)"
if [ -z "$assets" ]; then
  # /app may bounce before rendering; / always renders the same root shell.
  app_html="$(curl -sS --max-time 25 "$APP_URL/" || true)"
  assets="$(printf '%s' "$app_html" | grep -oE '/assets/[A-Za-z0-9_.-]+\.(css|js)' | sort -u || true)"
fi
if [ -z "$assets" ]; then
  echo "FATAL: could not extract any /assets/ reference from $APP_URL — the app shell did not render." >&2
  echo "       pm2 logs $APP_NAME --err --lines 50" >&2
  echo "       Database backup: $BACKUP_PATH" >&2
  exit 1
fi
asset_fail=0
asset_count=0
while IFS= read -r a; do
  [ -n "$a" ] || continue
  asset_count=$(( asset_count + 1 ))
  ac="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$APP_URL$a" || echo 000)"
  if [ "$ac" != "200" ]; then
    echo "FATAL: asset $a returned HTTP $ac (expected 200)." >&2
    asset_fail=1
  fi
done <<< "$assets"
if [ "$asset_fail" -ne 0 ]; then
  echo "       The served HTML references asset files that are not on disk (stale process or bad build)." >&2
  echo "       Fix: pm2 restart $APP_NAME --update-env, then re-run this script." >&2
  echo "       Database backup: $BACKUP_PATH" >&2
  exit 1
fi
echo "    $asset_count referenced asset(s) all resolve -> HTTP 200"

prune_backups

echo "==> Done. Live at $APP_URL"
pm2 list
