import { authenticateWebhook } from "../lib/webhook-auth.server";

export const loader = () => new Response(null, { status: 200 });

export const action = async ({ request }) => {
  const { shop, topic, payload } = await authenticateWebhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // GDPR: customer data must be deleted. This app stores no customer PII
  // beyond Shopify session records (keyed by shop, not customer), so there
  // is nothing customer-specific to delete.
  const customerId = payload?.customer?.id;
  console.log(`Customer redact request for customer ${customerId} in shop ${shop}`);

  return new Response();
};
