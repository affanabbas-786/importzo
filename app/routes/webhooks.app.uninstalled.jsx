import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }) => {
  let shop, session, topic;
  try {
    ({ shop, session, topic } = await authenticate.webhook(request));
  } catch (error) {
    // authenticate.webhook() tries to refresh the offline token before
    // returning. On app/uninstalled the token is already revoked, so the
    // refresh always fails and the SDK throws a bare 500 Response here —
    // HMAC validation has already passed by this point, so this isn't an
    // auth failure, just a dead token. Real auth failures (bad HMAC,
    // wrong method) still throw 401/400/405 and should still be rejected.
    if (error instanceof Response && [401, 400, 405].includes(error.status)) {
      throw error;
    }
    shop = request.headers.get("X-Shopify-Shop-Domain");
    topic = request.headers.get("X-Shopify-Topic");
  }

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (shop) {
    await db.session.deleteMany({ where: { shop } });
  }

  return new Response();
};
