import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";
import { SupportWidget } from "../components/SupportWidget";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";
import { NavProgress } from "../components/NavProgress";
import { PlanBadge } from "../components/PlanBadge";
import { getUsageStatus } from "../lib/usage.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");
  const hasToken = !!url.searchParams.get("id_token");
  console.log(`[importzo] app loader: shop=${shop} embedded=${url.searchParams.get("embedded")} has_id_token=${hasToken}`);
  let session;
  try {
    ({ session } = await authenticate.admin(request));
    console.log(`[importzo] app loader: auth OK for shop=${shop}`);
  } catch (e) {
    console.log(`[importzo] app loader: auth threw ${e?.constructor?.name} status=${e?.status} for shop=${shop}`);
    throw e;
  }

  const apiKey = process.env.SHOPIFY_API_KEY || ""; // eslint-disable-line no-undef
  if (!apiKey) {
    console.error("[importzo] SHOPIFY_API_KEY is not set — App Bridge will not initialize");
  }
  // Plan + remaining quota for the badge in the layout header. Deliberately
  // non-fatal: this is a decoration on every page in the app, and a plan
  // lookup failing must never be what stops a merchant from reaching one.
  // PlanBadge renders nothing when usage is null.
  let usage = null;
  try {
    const status = await getUsageStatus({ prisma, shop: session.shop });
    usage = {
      label: status.label,
      limit: status.limit,
      remaining: status.remaining,
      isUnlimited: status.isUnlimited,
    };
  } catch (err) {
    console.warn("[importzo] app loader: could not load plan usage for the badge:", err?.message);
  }

  return { apiKey, usage };
};

export default function App() {
  const { apiKey, usage } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <NavProgress />
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/import">Import</s-link>
        <s-link href="/app/export">Export</s-link>
        <s-link href="/app/transfer">Transfer Store</s-link>
        <s-link href="/app/scheduled-sync">Scheduled Sync</s-link>
        <s-link href="/app/activity">Activity</s-link>
        <s-link href="/app/billing">Billing</s-link>
        <s-link href="/app/settings">Settings</s-link>
      </s-app-nav>
      {/* Sits above the page rather than inside it: every route renders its
          own <s-page>, so this is the one place a persistent element can live
          without being repeated in (and drifting between) all of them. */}
      <div className="flex justify-end px-4 pt-3 -mb-1">
        <PlanBadge usage={usage} />
      </div>
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
