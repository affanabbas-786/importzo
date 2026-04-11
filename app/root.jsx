import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
  isRouteErrorResponse,
} from "react-router";
import tailwindHref from "./tailwind.css?url";

export const links = () => [
  { rel: "preconnect", href: "https://cdn.shopify.com/" },
  {
    rel: "stylesheet",
    href: "https://cdn.shopify.com/static/fonts/inter/v4/styles.css",
  },
  { rel: "stylesheet", href: tailwindHref },
];

export function Layout({ children }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <style dangerouslySetInnerHTML={{ __html: `
          @font-face {
            font-family: 'ImportzoFont';
            src: url('/myfonts.ttf') format('truetype');
            font-weight: normal;
            font-style: normal;
            font-display: swap;
          }
        ` }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

// Root-level ErrorBoundary — the last safety net. If an error escapes
// the app.jsx ErrorBoundary (e.g. AppProvider init fails with an empty
// apiKey), React used to crash with "Cannot read properties of null
// (reading 'useContext')" because there was nothing to catch it. This
// component renders without any providers so it can never fail.
export function ErrorBoundary() {
  let message = "Something went wrong. Please reload the page.";
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const error = useRouteError();
    if (isRouteErrorResponse(error) && typeof error.data === "string") {
      // Shopify auth/redirect response — render it verbatim so the
      // App Bridge redirect script can execute in the iframe.
      return <div dangerouslySetInnerHTML={{ __html: error.data }} />;
    }
    if (error?.message) message = error.message;
  } catch {
    // useRouteError itself failed — stick with generic message
  }
  return (
    <div style={{ maxWidth: 480, margin: "80px auto", textAlign: "center", fontFamily: "'ImportzoFont', Inter, system-ui, sans-serif", padding: "0 24px" }}>
      <div style={{ width: 64, height: 64, borderRadius: "50%", background: "rgba(239,68,68,0.08)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 20px" }}>
        <svg width="32" height="32" fill="none" viewBox="0 0 24 24" stroke="#EF4444" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
        </svg>
      </div>
      <h1 style={{ fontSize: 20, fontWeight: 600, color: "#17320A", marginBottom: 8 }}>We couldn&apos;t load Importzo</h1>
      <p style={{ fontSize: 14, color: "#6b7280", lineHeight: 1.6, marginBottom: 24 }}>
        {message}
      </p>
      <button
        onClick={() => { if (typeof window !== "undefined") window.location.reload(); }}
        style={{ background: "#17320A", color: "#fff", border: "none", borderRadius: 8, padding: "10px 24px", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
      >
        Reload Page
      </button>
      <p style={{ fontSize: 12, color: "#9ca3af", marginTop: 16 }}>
        If this keeps happening, contact{" "}
        <a href="mailto:support@dazzletech.co" style={{ color: "#2E6316", fontWeight: 500 }}>support@dazzletech.co</a>
      </p>
    </div>
  );
}
