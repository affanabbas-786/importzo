// ═══════════════════════════════════════════════════════════════════
// Webhook authentication that survives an API-secret rotation.
//
// THE PROBLEM THIS EXISTS TO FIX
//
// Shopify signs webhooks with the app's OLDEST UNREVOKED client secret. That
// means the moment a new secret is generated, there is a window — lasting
// until the old secret is revoked in the Dev Dashboard, which cannot happen
// until every stored access token has been re-pinned — in which the app is
// configured with the NEW secret while every genuine delivery is still signed
// with the OLD one.
//
// `authenticate.webhook()` verifies against exactly one secret, the single
// `apiSecretKey` the app was constructed with, and answers an HMAC mismatch
// with a bare 401. So switching the environment variable on its own does not
// just lose a few webhooks: it rejects ALL of them, silently, for as long as
// the rotation takes.
//
// Three of this app's six topics are customers/data_request,
// customers/redact and shop/redact — the mandatory compliance webhooks.
// Failing those repeatedly is an App Store problem, not merely lost data,
// which is why this is worth a shim rather than an accepted gap.
//
// THE SHIM
//
// Verify with the current secret first; if and only if that comes back as an
// HMAC rejection, verify again with the previous one. Both attempts go
// through the real library authenticator, so a delivery that passes the
// fallback yields exactly the same context — session, admin client, payload,
// topic — as one that passes normally. Nothing downstream can tell which
// secret verified it, and nothing downstream should.
//
// This is deliberately temporary. Remove SHOPIFY_API_SECRET_OLD from .env
// once the old secret is revoked and the app stops honouring a retired
// credential; the log line below is how you know that moment has arrived.
// ═══════════════════════════════════════════════════════════════════

import { authenticate, previousSecretWebhookAuthenticator } from "../shopify.server.js";

/**
 * True for the library's "this HMAC does not match" answer specifically.
 *
 * Narrow on purpose. The same authenticator throws 405 for a non-POST and
 * 400 for malformed or missing headers, and neither of those becomes valid
 * under a different key — retrying them against the old secret would only
 * do the work twice before failing identically.
 */
function isHmacRejection(err) {
  return err instanceof Response && err.status === 401;
}

/**
 * Drop-in replacement for `authenticate.webhook(request)`.
 *
 * Identical behaviour, including the exact Response it throws on failure,
 * whenever no rotation is in progress.
 */
export async function authenticateWebhook(request) {
  const primary = authenticate.webhook;

  // A non-POST never reaches HMAC checking at all — hand the original
  // request over and let the library answer 405. Cloning is skipped because
  // constructing a Request with a body on a GET throws.
  if (request.method !== "POST") return primary(request);

  // The body can only be consumed once, and the authenticator consumes it.
  // Buffer it here so a second attempt is possible; without this the
  // fallback would always verify an empty body and always fail.
  const rawBody = await request.text();
  const replay = () =>
    new Request(request.url, { method: "POST", headers: request.headers, body: rawBody });

  try {
    return await primary(replay());
  } catch (err) {
    const previous = previousSecretWebhookAuthenticator();
    if (!previous || !isHmacRejection(err)) throw err;

    let context;
    try {
      context = await previous(replay());
    } catch {
      // Rejected by both secrets: report the CURRENT secret's rejection, so
      // the response is the one this app would give with no rotation running.
      throw err;
    }

    console.warn(
      `[webhook-auth] ${context.topic} from ${context.shop} verified with the PREVIOUS API secret — ` +
      `Shopify is still signing with it, so the old secret must NOT be revoked yet`,
    );
    return context;
  }
}
