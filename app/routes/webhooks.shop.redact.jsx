import { authenticate } from "../shopify.server";

export const loader = () => new Response(null, { status: 200 });

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // GDPR: 48 hours after app uninstall, delete all shop data.
  // Dynamic import keeps db.server out of the client bundle.
  const db = (await import("../db.server")).default;

  await db.session.deleteMany({ where: { shop } });

  try {
    await db.importJob.deleteMany({ where: { shop } });
  } catch (_) { /* table may not exist on older deployments */ }

  try {
    await db.sourceStore.deleteMany({ where: { shop } });
  } catch (_) { /* table may not exist on older deployments */ }

  console.log(`Shop redact complete for ${shop}`);

  return new Response();
};
