import { Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }) => {
  await authenticate.admin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "" };
};

export default function App() {
  const { apiKey } = useLoaderData();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Dashboard</s-link>
        <s-link href="/app/product-importer">Product Importer</s-link>
        <s-link href="/app/customers">Customers</s-link>
        <s-link href="/app/collections">Collection Importer</s-link>
        <s-link href="/app/inventory">Inventory Update</s-link>
        <s-link href="/app/collection-transfer">Collection Transfer</s-link>
        <s-link href="/app/export">Export Data</s-link>
      </s-app-nav>
      <Outlet />
      <footer className="py-6 text-center border-t border-gray-100 mt-10">
        <div className="flex items-center justify-center gap-1.5">
          <svg width="14" height="14" className="w-3.5 h-3.5" style={{ color: "#2E6316" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
          </svg>
          <p className="text-xs text-gray-400">
            Powered by{" "}
            <a
              href="https://dazzletech.co"
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold transition-colors duration-300"
              style={{ color: "#2E6316" }}
            >
              dazzletech.co
            </a>
          </p>
        </div>
      </footer>
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
