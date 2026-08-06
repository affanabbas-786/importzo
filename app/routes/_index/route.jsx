import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { redirect } from "react-router";

// This route previously ended in `redirect("https://importzo.dazzletech.co")`,
// on the assumption that nginx served public/landing.html for / and this branch
// was therefore unreachable. nginx has no such rule — its `location /` proxies
// every path here — so that branch was in fact the live path for every visitor,
// redirecting / to itself: an infinite loop, ERR_TOO_MANY_REDIRECTS.
//
// The marketing page is now served from here rather than depending on nginx to
// intercept a path it never intercepted. Vite copies public/ into build/client/
// at build time, so the built file is the one to prefer; public/ is the source
// of truth in dev, where no build output exists.
const LANDING_CANDIDATES = ["build/client/landing.html", "public/landing.html"];

let cachedLanding;

async function readLandingPage() {
  if (cachedLanding) return cachedLanding;

  for (const candidate of LANDING_CANDIDATES) {
    try {
      cachedLanding = await readFile(join(process.cwd(), candidate), "utf8");
      return cachedLanding;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

// No default export: this is a resource route, so the Response below is sent
// verbatim instead of being treated as loader data for a component.
export const loader = async ({ request }) => {
  const url = new URL(request.url);

  // Shopify sends merchants to / with ?shop=... on install and on every open
  // from the admin. That must keep reaching the embedded app.
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  const html = await readLandingPage();

  // Falling back to the static copy rather than 500-ing: /landing.html is served
  // straight off build/client by react-router-serve, so it stays reachable even
  // if this read fails. It is one hop and it terminates — never back to /.
  if (html === null) return redirect("/landing.html");

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};
