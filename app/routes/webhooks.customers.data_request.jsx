import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // GDPR: customer data request — no personal data stored beyond sessions,
  // nothing to return. Respond 200 to acknowledge receipt.
  return new Response();
};
