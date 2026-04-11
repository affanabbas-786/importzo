// ═══════════════════════════════════════════════════════════════════
// Importzo — Friendly Error Boundary
// Wraps raw crashes in a calm, on-brand error page. Merchants never
// see stack traces — they see a reassuring screen with recovery actions.
//
// IMPORTANT: Do NOT call Shopify's `boundary.error(error)` eagerly when
// building this component. That helper throws the original error for
// anything other than an ErrorResponse, which crashes the ErrorBoundary
// itself and cascades into React's "Cannot read properties of null
// (reading 'useContext')" crash. We reimplement the auth/redirect case
// inline (it is a 2-line snippet) and render the friendly UI for
// everything else.
// ═══════════════════════════════════════════════════════════════════

import { isRouteErrorResponse } from "react-router";

const P = "#17320A";
const S = "#2E6316";
const F = "'ImportzoFont', sans-serif";

const SUPPORT_EMAIL = "support@dazzletech.co";

function toMessage(error) {
  if (!error) return "";
  if (isRouteErrorResponse(error)) {
    return `${error.status} ${error.statusText || ""}`.trim();
  }
  if (typeof error === "string") return error;
  return error.message || "";
}

// Shopify's boundary.error() renders a div with dangerouslySetInnerHTML
// for auth/redirect responses — we replicate it here to stay client-safe.
function isShopifyAuthResponse(error) {
  if (!error) return false;
  if (isRouteErrorResponse(error)) return true;
  const name = error?.constructor?.name;
  return name === "ErrorResponse" || name === "ErrorResponseImpl";
}

export function FriendlyErrorBoundary({
  heading = "Something went wrong",
  title = "We hit an unexpected issue",
  message = "Please try again. If the problem continues, contact support and we'll help you get back on track.",
  error,
}) {
  // Auth / redirect responses from Shopify must be rendered verbatim so
  // their App Bridge redirect script runs in the embedded iframe.
  if (isShopifyAuthResponse(error) && typeof error?.data === "string") {
    return <div dangerouslySetInnerHTML={{ __html: error.data || "Handling response" }} />;
  }

  const detail = toMessage(error);

  // Render with plain HTML — NOT <s-page>, which depends on App Bridge.
  // When this component is used in the app.jsx ErrorBoundary, App Bridge
  // is not available (its loader failed), so Shopify web components
  // would silently break or throw. Plain divs always work.
  return (
    <div style={{ maxWidth: 540, margin: "60px auto", padding: "0 20px" }}>
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-8 text-center">
        <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-5" style={{ background: "rgba(239,68,68,0.08)" }}>
          <svg className="w-8 h-8 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        </div>
        <h2 className="text-lg font-semibold text-gray-900" style={{ fontFamily: F }}>{title}</h2>
        <p className="text-sm text-gray-500 mt-2 leading-relaxed">{message}</p>

        {detail && (
          <details className="mt-4 text-left">
            <summary className="text-xs font-medium text-gray-400 cursor-pointer hover:text-gray-600 text-center">
              Technical details
            </summary>
            <pre className="mt-2 text-[11px] text-gray-500 bg-gray-50 border border-gray-100 rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap break-words">
              {detail}
            </pre>
          </details>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <button
            onClick={() => { if (typeof window !== "undefined") window.location.reload(); }}
            style={{ background: P, color: "#fff", fontFamily: F }}
            className="px-5 py-2.5 text-sm font-semibold rounded-lg shadow-sm hover:brightness-110 active:scale-[0.98] transition-all"
          >
            Try Again
          </button>
          <a
            href="/app"
            className="px-4 py-2.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Back to Dashboard
          </a>
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent("Importzo issue — " + heading)}&body=${encodeURIComponent("Hi Importzo team,\n\nI ran into an issue:\n" + (detail || "(no details)") + "\n\n")}`}
            className="px-4 py-2.5 text-sm font-medium rounded-lg border transition-colors"
            style={{ color: S, borderColor: "rgba(46,99,22,0.3)" }}
          >
            Contact Support
          </a>
        </div>
      </div>

      <p className="text-center text-xs text-gray-400 mt-4">
        Need help right now? Use the live chat bubble in the bottom-right corner.
      </p>
    </div>
  );
}
