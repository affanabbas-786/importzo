#!/bin/bash
# Runs the offline ThemeJob verification suite.
#
#   bash test/harness/run.sh
#
# Generates a throwaway cert and SQLite database on first run. Touches no real
# store and no real database — see README.md.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$HERE/../.." && pwd)"
cd "$APP_DIR"

if [ ! -f "$HERE/certs/cert.pem" ]; then
  echo "==> Generating a self-signed cert for the fake stores..."
  mkdir -p "$HERE/certs"
  openssl req -x509 -newkey rsa:2048 -keyout "$HERE/certs/key.pem" -out "$HERE/certs/cert.pem" \
    -days 365 -nodes -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" 2>/dev/null
fi

# Named "harness", never "production": app/lib/database-guard.js refuses to let a
# non-production process open anything matching /production/i.
export DATABASE_URL="file:$HERE/harness.sqlite"
if [ ! -f "$HERE/harness.sqlite" ]; then
  echo "==> Creating the throwaway database..."
  npx prisma db push --skip-generate >/dev/null
fi
mkdir -p "$HERE/tmp"

fail=0
for s in "$HERE"/scenario-*.mjs; do
  echo
  node "$s" || fail=1
done
echo
[ "$fail" -eq 0 ] && echo "ALL SCENARIOS PASSED" || { echo "SOME SCENARIOS FAILED"; exit 1; }
