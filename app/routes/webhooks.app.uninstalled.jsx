import { authenticateWebhook } from "../lib/webhook-auth.server";
import db from "../db.server";
import { cascadeRevokePartnerLinks } from "../lib/partner-linking.server";

export const action = async ({ request }) => {
  let shop, topic;
  try {
    ({ shop, topic } = await authenticateWebhook(request));
  } catch (error) {
    // authenticateWebhook() tries to refresh the offline token before
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

    // Uninstall is not erasure — shop/redact does that 48h later. But the
    // shop's offline token is revoked the moment the app is uninstalled, so
    // any enabled ScheduledSync would keep firing against a dead credential
    // until it burned through its failure budget. Disable them immediately,
    // with a reason the merchant sees if they reinstall.
    try {
      const { count } = await db.scheduledSync.updateMany({
        where: { shop, enabled: true },
        data: {
          enabled: false,
          disabledReason: "Disabled automatically because the app was uninstalled from this store.",
        },
      });
      if (count) console.log(`[app/uninstalled] ${shop}: disabled ${count} scheduled sync(s)`);
    } catch (err) {
      // Table may not exist on an older deployment — non-fatal.
      console.warn(`[app/uninstalled] ${shop}: could not disable scheduled syncs:`, err?.message);
    }

    // Phase 5: marks this shop's row as no longer installed so it drops out
    // of Agency eligibility's "stores with Importzo installed" count for
    // every other shop sharing its owner email (agency-eligibility.server.js
    // filters on uninstalledAt: null) — without waiting for shop/redact,
    // which doesn't hard-delete the row for another 48h. updateMany (not
    // update) so a shop that uninstalls before ever creating a ShopPlan row
    // is a silent no-op rather than a thrown "record not found".
    try {
      await db.shopPlan.updateMany({ where: { shop }, data: { uninstalledAt: new Date() } });
    } catch (err) {
      console.warn(`[app/uninstalled] ${shop}: could not mark shopPlan uninstalled:`, err?.message);
    }

    // Phase 12 — this shop may be a PAYER funding other stores' Pro access
    // (see partner-linking.server.js). Uninstalling doesn't reliably also
    // fire app_subscriptions/update, so this cascade has to run from here
    // too, not just from that webhook.
    try {
      const { total, reverted } = await cascadeRevokePartnerLinks({ prisma: db, payerShop: shop });
      if (total) console.log(`[app/uninstalled] ${shop}: reverted ${reverted}/${total} linked partner store(s)`);
    } catch (err) {
      console.warn(`[app/uninstalled] ${shop}: partner-link cascade failed:`, err?.message);
    }
  }

  return new Response();
};
