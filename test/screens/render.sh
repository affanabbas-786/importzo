#!/bin/bash
# Renders the real UI components to a PNG you can actually look at.
#
#   bash test/screens/render.sh            # writes test/screens/out/screens.png
#
# Needs a `npm run build` first (it reuses the app's compiled Tailwind), and a
# chromium on PATH. Nothing here touches a store, a database, or the network.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$HERE/../.." && pwd)"
cd "$APP_DIR"

CSS="$(ls -t build/client/assets/tailwind-*.css 2>/dev/null | head -1 || true)"
[ -n "$CSS" ] || { echo "No built CSS found — run 'npm run build' first." >&2; exit 1; }

CHROME="$(command -v chromium-browser || command -v chromium || command -v google-chrome || true)"
[ -n "$CHROME" ] || { echo "No chromium on PATH." >&2; exit 1; }

# Snap-packaged chromium gets a PRIVATE /tmp, so a --screenshot path under /tmp
# silently fails to write. Stage everything somewhere it can actually reach.
WORK="${SCREENS_WORKDIR:-$HOME/importzo-screens}"
mkdir -p "$WORK" "$HERE/out"

npx esbuild "$HERE/gallery.jsx" --bundle --platform=node --format=cjs \
  --jsx=automatic --outfile="$WORK/gallery.cjs" --log-level=error

cp "$CSS" "$WORK/tw.css"
{
  echo '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="tw.css">'
  echo '<style>body{margin:0;background:#F6F6F3;font-family:system-ui,-apple-system,sans-serif}</style>'
  node "$WORK/gallery.cjs" 2>/dev/null
} > "$WORK/screens.html"

"$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
  --force-device-scale-factor="${SCALE:-1.6}" --window-size="${SIZE:-980,1560}" \
  --force-prefers-reduced-motion \
  --screenshot="$WORK/screens.png" "file://$WORK/screens.html" 2>&1 | grep -viE "upower|dbus|^\\[" || true

cp "$WORK/screens.png" "$HERE/out/screens.png"
echo "==> $HERE/out/screens.png"
