import { useRouteError, isRouteErrorResponse } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  console.log(`[importzo] auth.$ loader: ${url.pathname} shop=${url.searchParams.get("shop")} has_id_token=${!!url.searchParams.get("id_token")}`);
  await authenticate.admin(request);
  return null;
};

// Render Shopify's App Bridge HTML verbatim (bounce page / exit-iframe).
// Without this boundary, the thrown Response bubbles to the root boundary
// which also works, but having it here keeps error headers propagation clean.
export function ErrorBoundary() {
  const error = useRouteError();
  // Only render as HTML when data is actually an HTML string (Shopify auth redirect)
  if (isRouteErrorResponse(error) && typeof error.data === "string" && error.data.trimStart().startsWith("<")) {
    return <div dangerouslySetInnerHTML={{ __html: error.data }} />;
  }
  // Unexpected error — show minimal text so the merchant can reload.
  return (
    <div style={{ padding: 40, fontFamily: "sans-serif", textAlign: "center" }}>
      <p style={{ color: "#666" }}>Authentication error. Please reload the page.</p>
    </div>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
