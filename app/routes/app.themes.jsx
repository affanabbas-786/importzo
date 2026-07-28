// Redirect /app/themes → /app/transfer (where theme transfer lives)
import { redirect, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  url.pathname = "/app/transfer";
  throw redirect(url.toString());
};

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <FriendlyErrorBoundary
      heading="Themes"
      title="Redirect failed"
      message="Please navigate to Transfer Store from the main menu."
      error={error}
    />
  );
}

export const headers = (headersArgs) => boundary.headers(headersArgs);
