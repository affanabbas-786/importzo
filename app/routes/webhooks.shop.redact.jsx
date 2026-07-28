import { authenticate } from "../shopify.server";

export const loader = () => new Response(null, { status: 200 });

export const action = async ({ request }) => {
  // authenticate.webhook() verifies the Shopify HMAC signature and rejects
  // unsigned/tampered requests before anything below runs. This handler
  // performs irreversible deletion, so that verification is what stands
  // between an attacker and wiping a merchant's data by POSTing here.
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Dynamic imports keep server-only modules out of the client bundle.
  const db = (await import("../db.server")).default;
  const { deleteShopData, summarizeErasure } = await import("../lib/shop-data.server");

  // GDPR: 48 hours after uninstall, erase everything held for this shop.
  // This previously deleted only session/importJob/sourceStore, leaving
  // behind MigrationJob and ScheduledSync (both hold encrypted access
  // tokens), StoreBackup (a full snapshot of the shop's catalog),
  // TransferSession, ProductMapping and TransferLogEntry.
  const result = await deleteShopData(db, shop);
  const summary = summarizeErasure(result);

  console.log(
    `[shop/redact] ${shop}: deleted ${summary.totalRecordsDeleted} record(s) across ` +
    `${summary.modelsCleared} model(s)`,
    result.deleted,
  );

  // Log loudly on partial erasure — an incomplete deletion is a compliance
  // problem and must not read as success.
  if (result.errors.length) {
    console.error(`[shop/redact] ${shop}: ${result.errors.length} model(s) FAILED to erase:`, result.errors);
  }

  // Always 200: Shopify retries non-2xx, and a retry would re-run an
  // already-successful erasure. Failures are surfaced in the logs above.
  return new Response();
};
