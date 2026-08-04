import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { SupportWidget } from "../components/SupportWidget";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";
import { NavProgress } from "../components/NavProgress";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const hasToken = !!url.searchParams.get("id_token");
  console.log(`[importzo] app loader: shop=${shop} embedded=${url.searchParams.get("embedded")} has_id_token=${hasToken}`);
  try {
    await authenticate.admin(request);
    console.log(`[importzo] app loader: auth OK for shop=${shop}`);
  } catch (e) {
    console.log(`[importzo] app loader: auth threw ${e?.constructor?.name} status=${e?.status} for shop=${shop}`);
    throw e;
  }

  const apiKey = process.env.SHOPIFY_API_KEY || ""; // eslint-disable-line no-undef
  if (!apiKey) {
    console.error("[importzo] SHOPIFY_API_KEY is not set — App Bridge will not initialize");
  }
  return { apiKey };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavProgress />
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/import">Import</s-link>
        <s-link href="/app/export">Export</s-link>
        <s-link href="/app/transfer">Transfer Store</s-link>
        <s-link href="/app/activity">Activity</s-link>
        <s-link href="/app/billing">Billing</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      <Outlet />
      {/* Live chat — loaded once, persists across every page */}
      <SupportWidget />
    </AppProvider>
  );
}

// App-level error boundary. Renders the friendly error page without
// depending on AppProvider — wrapping in AppProvider with an empty
// apiKey used to crash App Bridge init and cascade into the infamous
// "Cannot read properties of null (reading 'useContext')" React error.
// Now we render the friendly UI with plain HTML/Tailwind so it can
// never fail, and the root ErrorBoundary is the final safety net.
export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <FriendlyErrorBoundary
      heading="Importzo"
      title="We couldn't load this page"
      message="Something went wrong on our side. Please try again, or contact support if the issue continues."
      error={error}
    />
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
