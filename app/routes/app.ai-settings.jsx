import { useState, useEffect, useCallback, useMemo } from "react";
import { useFetcher, useRouteError, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";

// ═══════════════════════════════════════════════════════════════════
// Phase 4.4 — AI cleanup settings: bring-your-own LLM API key.
//
// Importzo never holds or bills a shared LLM key — each merchant pastes
// their own Anthropic or OpenAI API key here, encrypted at rest
// (ai-settings.server.js / encryption.server.js), used only to generate
// SEO suggestions for their own store when they explicitly ask for one.
// ═══════════════════════════════════════════════════════════════════

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

const P = "#17320A";
const S = "#2E6316";
const F = "'ImportzoFont', sans-serif";

export default function AiSettingsPage() {
  const shopify = useAppBridge();
  const dataFetcher = useFetcher();
  const actionFetcher = useFetcher();

  const [provider, setProvider] = useState("anthropic");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");

  useEffect(() => {
    if (dataFetcher.state === "idle" && !dataFetcher.data) {
      dataFetcher.load("/api/ai-settings");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const integration = dataFetcher.data?.integration || null;
  const suggestedModels = useMemo(
    () => dataFetcher.data?.suggestedModels || { anthropic: "claude-haiku-4-5", openai: "gpt-4o-mini" },
    [dataFetcher.data],
  );

  useEffect(() => {
    if (integration) {
      setProvider(integration.provider);
      setModel(integration.model || "");
    }
  }, [integration]);

  useEffect(() => {
    if (actionFetcher.data?.ok && actionFetcher.state === "idle") {
      dataFetcher.load("/api/ai-settings");
      setApiKey("");
      shopify.toast.show(actionFetcher.data.integration ? "AI settings saved" : "AI integration removed");
    } else if (actionFetcher.data?.ok === false && actionFetcher.state === "idle") {
      shopify.toast.show(actionFetcher.data.error || "Something went wrong", { isError: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionFetcher.data, actionFetcher.state]);

  const handleSave = useCallback(() => {
    if (!apiKey.trim()) {
      shopify.toast.show("Enter an API key", { isError: true });
      return;
    }
    const fd = new FormData();
    fd.append("intent", "save");
    fd.append("provider", provider);
    fd.append("apiKey", apiKey);
    fd.append("model", model || suggestedModels[provider] || "");
    actionFetcher.submit(fd, { method: "POST", action: "/api/ai-settings" });
  }, [apiKey, provider, model, suggestedModels, actionFetcher, shopify]);

  const handleRemove = useCallback(() => {
    const fd = new FormData();
    fd.append("intent", "delete");
    actionFetcher.submit(fd, { method: "POST", action: "/api/ai-settings" });
  }, [actionFetcher]);

  const handleToggle = useCallback((enabled) => {
    const fd = new FormData();
    fd.append("intent", enabled ? "enable" : "disable");
    actionFetcher.submit(fd, { method: "POST", action: "/api/ai-settings" });
  }, [actionFetcher]);

  const isSaving = actionFetcher.state !== "idle";

  return (
    <s-page heading="AI SEO Cleanup" backAction={JSON.stringify({ content: "Settings", url: "/app/settings" })}>
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: P, fontFamily: F }}>AI SEO Cleanup</span>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-1" style={{ fontFamily: F }}>Bring your own AI key</h2>
          <p className="text-sm text-gray-500 mb-5 leading-relaxed">
            Importzo doesn&apos;t include an AI subscription — connect your own Anthropic or OpenAI account and we&apos;ll use
            it, only when you explicitly ask, to suggest an SEO-friendlier title and meta description for a product
            after import. Nothing is generated or changed automatically. Your key is encrypted and never shown again
            after saving.
          </p>

          {integration && (
            <div className="mb-5 rounded-lg border border-green-200 bg-green-50/40 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
              <div>
                <p className="text-sm font-medium text-gray-900">
                  Connected: {integration.provider === "anthropic" ? "Anthropic (Claude)" : "OpenAI"}
                  {" "}&middot; {integration.model}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">{integration.enabled ? "Enabled" : "Disabled"}</p>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => handleToggle(!integration.enabled)}
                  className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
                  {integration.enabled ? "Disable" : "Enable"}
                </button>
                <button type="button" onClick={handleRemove}
                  className="px-3 py-1.5 text-xs font-medium text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50">
                  Remove key
                </button>
              </div>
            </div>
          )}

          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-gray-700 mb-2">Provider</p>
              <div className="grid grid-cols-2 gap-2 max-w-sm">
                {[
                  { val: "anthropic", label: "Anthropic (Claude)" },
                  { val: "openai", label: "OpenAI" },
                ].map((opt) => (
                  <button key={opt.val} type="button" onClick={() => { setProvider(opt.val); setModel(""); }}
                    className={`text-left p-3 rounded-lg border-2 transition-all ${provider === opt.val ? "border-green-700/40 bg-green-50/30" : "border-gray-200 bg-white hover:border-gray-300"}`}>
                    <p className="text-xs font-semibold text-gray-900">{opt.label}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="max-w-sm">
              <label htmlFor="ai-api-key" className="text-sm font-medium text-gray-700 mb-1 block">API key</label>
              <input id="ai-api-key" type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                placeholder={integration ? "Enter a new key to replace the saved one" : (provider === "anthropic" ? "sk-ant-..." : "sk-...")}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-green-800/20" />
              <p className="text-xs text-gray-400 mt-1">
                Stored encrypted. We never display it again after saving — to change it, paste a new one.
              </p>
            </div>

            <div className="max-w-sm">
              <label htmlFor="ai-model" className="text-sm font-medium text-gray-700 mb-1 block">Model (optional)</label>
              <input id="ai-model" type="text" value={model} onChange={(e) => setModel(e.target.value)}
                placeholder={suggestedModels[provider]}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg outline-none focus:ring-2 focus:ring-green-800/20" />
              <p className="text-xs text-gray-400 mt-1">
                Defaults to {suggestedModels[provider]} (fast/inexpensive — plenty for short SEO copy). Enter a different
                model name if you&apos;d rather use a higher-quality tier.
              </p>
            </div>

            <button type="button" onClick={handleSave} disabled={isSaving}
              style={{ background: P, color: "#fff", borderRadius: 8, fontWeight: 600, fontFamily: F }}
              className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 transition-all active:scale-[0.98] disabled:opacity-50">
              {isSaving ? "Saving..." : "Save"}
            </button>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
          <p className="text-sm font-semibold text-gray-900 mb-1">Where to use it</p>
          <p className="text-xs text-gray-500 leading-relaxed">
            Once connected, look for &quot;Improve with AI&quot; next to newly-imported products on the{" "}
            <Link to="/app/product-importer" className="font-medium" style={{ color: S }}>Product Importer</Link> results
            screen. You review every suggestion before anything is written to the product — nothing is applied
            automatically.
          </p>
        </div>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <FriendlyErrorBoundary heading="AI SEO Cleanup" title="We couldn't load AI settings" message="Please try again." error={error} />
  );
}
export const headers = (headersArgs) => boundary.headers(headersArgs);
