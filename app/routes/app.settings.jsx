import PropTypes from "prop-types";
import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, useRouteError, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getUsageStatus } from "../lib/usage.server";
import { PLANS, PLAN_IDS, yearlySavingsPercent } from "../lib/plans.js";
import { BRAND } from "../lib/constants";
import { SUPPORT_EMAIL, mailtoLink, openLiveChat } from "../lib/support";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";
import { DEFAULT_PREFS, loadPrefs, savePrefs, resetPrefs, canPersist } from "../lib/prefs";
import { DecorativeBanner, DecorativeCorner } from "../components/decor";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  // Read-only local snapshot — no Shopify API call and no reconciliation
  // against the actual AppSubscription (that's app.billing.jsx's job, run
  // there so it doesn't fire on every Settings page load). Good enough for
  // a summary card that links out to manage the subscription itself.
  const usage = await getUsageStatus({ prisma, shop: session.shop });

  // Phase 12 — Partner/Agency linking. usage.partnerLinkedTo already carries
  // "who's paying for me"; linking is initiated entirely by the payer (it
  // just needs this store's myshopify domain), so there's nothing for this
  // store to generate or configure here.
  return { usage };
};

const { primary: P, secondary: S, font: F } = BRAND;

function SupportAction({ icon, title, description, actionLabel, href, onClick, external }) {
  const Tag = href ? "a" : "button";
  const props = href
    ? { href, ...(external ? { target: "_blank", rel: "noopener noreferrer" } : {}) }
    : { type: "button", onClick };
  return (
    <Tag
      {...props}
      className="group flex items-start gap-4 p-5 rounded-xl border border-gray-200 bg-white shadow-sm hover:shadow-md hover:-translate-y-0.5 hover:border-gray-300 transition-all text-left w-full"
    >
      <div
        className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: "rgba(23,50,10,0.08)", color: S }}
      >
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>{title}</p>
        <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">{description}</p>
        <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold group-hover:gap-1.5 transition-all" style={{ color: S }}>
          {actionLabel}
          <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" />
          </svg>
        </span>
      </div>
    </Tag>
  );
}

SupportAction.propTypes = {
  icon: PropTypes.node,
  title: PropTypes.string,
  description: PropTypes.string,
  actionLabel: PropTypes.string,
  href: PropTypes.string,
  onClick: PropTypes.func,
  external: PropTypes.bool,
};

function Toggle({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      style={{ background: checked ? P : "#d1d5db" }}
    >
      <span
        className="inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform"
        style={{ transform: checked ? "translateX(22px)" : "translateX(4px)" }}
      />
    </button>
  );
}

Toggle.propTypes = {
  checked: PropTypes.bool,
  onChange: PropTypes.func,
  disabled: PropTypes.bool,
};

// ── Phase 12 — Partner/Agency linking, the companion's own card ──────────
// Linking is done entirely by the payer (they enter this store's myshopify
// domain — there's no code to generate). So this card only has something to
// show once this store IS a companion: who's funding it, and an Unlink
// button. When not linked it renders nothing.
function PartnerLinkCard({ partnerLinkedTo }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";

  const post = (fields) => {
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => fd.append(k, String(v)));
    fetcher.submit(fd, { method: "post", action: "/api/partner-link" });
  };

  if (!partnerLinkedTo) return null;

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-gray-900 flex items-center gap-1.5" style={{ fontFamily: F }}>
          Companion Store
        </h2>
        <p className="text-sm text-gray-500 mt-0.5">
          Your Pro access is funded by another store&apos;s subscription.
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>
              Pro features provided by {partnerLinkedTo}
            </p>
            <p className="text-xs text-gray-500 mt-0.5">
              You can unlink at any time — this store keeps your data, but reverts to the Free plan.
            </p>
          </div>
          <button
            type="button" disabled={busy}
            onClick={() => post({ intent: "unlink-self" })}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg text-red-700 border border-red-200 hover:bg-red-50 disabled:opacity-50 flex-shrink-0"
          >
            {busy ? "Unlinking…" : "Unlink"}
          </button>
        </div>
      </div>
    </section>
  );
}

PartnerLinkCard.propTypes = {
  partnerLinkedTo: PropTypes.string,
};

export default function SettingsPage() {
  const { usage } = useLoaderData();
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [savedFlash, setSavedFlash] = useState(false);
  const [storageAvailable, setStorageAvailable] = useState(true);

  // Hydrate from localStorage after mount (SSR-safe); detect storage availability
  useEffect(() => {
    setStorageAvailable(canPersist());
    setPrefs(loadPrefs());
  }, []);

  function update(patch) {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(patch);
    setSavedFlash(true);
    const t = setTimeout(() => setSavedFlash(false), 1500);
    return () => clearTimeout(t);
  }

  function handleReset() {
    resetPrefs();
    setPrefs(DEFAULT_PREFS);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }

  return (
    <s-page
      heading="Settings"
      backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}
    >
      <div className="space-y-6 animate-fade-in">
        {/* ── Header (logo/wordmark unchanged; faint page-level corner accent behind it) ── */}
        <div className="relative overflow-hidden rounded-2xl -m-2 p-2">
          <DecorativeCorner position="top-right" />
          <div className="relative flex items-center gap-2.5">
            <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
            <span style={{ fontSize: 18, fontWeight: 600, color: P, fontFamily: F }}>Settings</span>
            {savedFlash && (
              <span className="ml-auto text-xs font-medium px-2 py-1 rounded-full" style={{ background: "rgba(46,99,22,0.1)", color: S }}>
                Saved
              </span>
            )}
          </div>
        </div>

        {/* ── Plan & Usage ── */}
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900 flex items-center gap-1.5" style={{ fontFamily: F }}>
              Plan &amp; Usage
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">Manage your subscription and see this month&apos;s record usage.</p>
          </div>
          <Link
            to="/app/billing"
            className="group flex items-start gap-4 p-5 rounded-xl border border-gray-200 bg-white shadow-sm hover:shadow-md hover:-translate-y-0.5 hover:border-gray-300 transition-all text-left w-full block"
          >
            <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "rgba(23,50,10,0.08)", color: S }}>
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3M3.75 19.5h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>
                {usage.label} plan
                {!usage.isUnlimited && (
                  <span className="font-normal text-gray-500"> — {usage.used.toLocaleString()} / {usage.limit.toLocaleString()} records this month</span>
                )}
                {usage.isUnlimited && <span className="font-normal text-gray-500"> — unlimited records</span>}
              </p>
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                View plans, upgrade, or manage your subscription. Paid plans start at
                ${PLANS[PLAN_IDS.PRO].price}/month, or ${PLANS[PLAN_IDS.PRO].priceYearly}/year
                to save {yearlySavingsPercent(PLAN_IDS.PRO)}%.
              </p>
              <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold group-hover:gap-1.5 transition-all" style={{ color: S }}>
                Go to Billing
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
              </span>
            </div>
          </Link>
        </section>

        <PartnerLinkCard partnerLinkedTo={usage.partnerLinkedTo} />

        {/* ── Import & Transfer defaults ── */}
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900 flex items-center gap-1.5" style={{ fontFamily: F }}>
              Import &amp; Transfer defaults
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">
              These defaults are applied every time you start a new import or store transfer. You can still override them per job.
            </p>
          </div>

          {/* Duplicate handling */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
            <p className="text-sm font-semibold text-gray-900 mb-1">Default duplicate handling</p>
            <p className="text-xs text-gray-500 mb-3">
              What should happen when an item (by handle / SKU) already exists in the destination store?
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {[
                { val: "skip", label: "Skip duplicates", desc: "Leave existing data untouched" },
                { val: "create", label: "Create as new", desc: "Always insert as a new item" },
                { val: "overwrite", label: "Overwrite", desc: "Replace existing data (caution)" },
              ].map((opt) => (
                <button
                  key={opt.val}
                  type="button"
                  onClick={() => update({ duplicateHandling: opt.val })}
                  className={`text-left p-3 rounded-lg border-2 transition-all ${prefs.duplicateHandling === opt.val ? "border-green-700/40 bg-green-50/30" : "border-gray-200 bg-white hover:border-gray-300"}`}
                >
                  <p className="text-xs font-semibold text-gray-900">{opt.label}</p>
                  <p className="text-[10px] text-gray-500 mt-0.5">{opt.desc}</p>
                </button>
              ))}
            </div>
          </div>

          {/* Dry run default */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">Start new jobs in Dry Run mode</p>
              <p className="text-xs text-gray-500 mt-1">
                Safer default — simulates the job first so you can review what would happen before committing.
              </p>
            </div>
            <Toggle checked={!!prefs.dryRunByDefault} onChange={(v) => update({ dryRunByDefault: v })} />
          </div>

          {/* Confirm destructive actions */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">Confirm before overwrite operations</p>
              <p className="text-xs text-gray-500 mt-1">
                Show an extra confirmation prompt before any action that may overwrite existing products, collections or themes.
              </p>
            </div>
            <Toggle checked={!!prefs.confirmDestructive} onChange={(v) => update({ confirmDestructive: v })} />
          </div>

          {/* Auto-download error CSVs */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">Auto-download error reports</p>
              <p className="text-xs text-gray-500 mt-1">
                When a job finishes with failures, automatically offer the downloadable CSV of failed items.
              </p>
            </div>
            <Toggle checked={!!prefs.autoDownloadErrorReports} onChange={(v) => update({ autoDownloadErrorReports: v })} />
          </div>

          {/* AI alt-text auto-generation — opt-in, off by default */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">Auto-generate image alt text</p>
              <p className="text-xs text-gray-500 mt-1">
                During import and transfer, use AI to write alt text for product images that don&apos;t have any yet,
                based on the product&apos;s title and description. Requires an AI integration —{" "}
                <Link to="/app/ai-settings" className="font-medium hover:underline" style={{ color: S }}>connect one in AI SEO Cleanup</Link>.
              </p>
            </div>
            <Toggle checked={!!prefs.altTextAutoGenerate} onChange={(v) => update({ altTextAutoGenerate: v })} />
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={handleReset}
              className="px-4 py-2 text-xs font-medium text-gray-600 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
            >
              Reset to defaults
            </button>
            {storageAvailable ? (
              <p className="text-[11px] text-gray-400">
                Preferences are stored in your browser for this store.
              </p>
            ) : (
              <p className="text-[11px] text-amber-600 font-medium">
                Browser storage is blocked (incognito or iframe restrictions) — preferences will reset on reload.
              </p>
            )}
          </div>
        </section>

        {/* ── AI SEO Cleanup ── */}
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900 flex items-center gap-1.5" style={{ fontFamily: F }}>
              AI SEO Cleanup
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">Optional, bring-your-own-key AI title/description suggestions after import.</p>
          </div>
          <Link
            to="/app/ai-settings"
            className="group flex items-start gap-4 p-5 rounded-xl border border-gray-200 bg-white shadow-sm hover:shadow-md hover:-translate-y-0.5 hover:border-gray-300 transition-all text-left w-full block"
          >
            <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "rgba(23,50,10,0.08)", color: S }}>
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>Connect your Anthropic or OpenAI key</p>
              <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">
                Importzo never bills you for AI usage — connect your own key and review every suggestion before it&apos;s applied.
              </p>
              <span className="mt-2 inline-flex items-center gap-1 text-xs font-semibold group-hover:gap-1.5 transition-all" style={{ color: S }}>
                Manage AI settings
                <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5L21 12m0 0l-7.5 7.5M21 12H3" /></svg>
              </span>
            </div>
          </Link>
        </section>

        {/* ── Notifications ── */}
        <section className="space-y-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900 flex items-center gap-1.5" style={{ fontFamily: F }}>
              Notifications
            </h2>
            <p className="text-sm text-gray-500 mt-0.5">Get notified when imports and transfers finish.</p>
          </div>

          {/* Browser notification on completion */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">Browser notification on job completion</p>
              <p className="text-xs text-gray-500 mt-1">
                Shows a desktop notification when an import, export, or transfer finishes — useful when running long jobs in a background tab.
              </p>
              {typeof window !== "undefined" && prefs.notifyOnComplete && (() => {
                const inFrame = window !== window.top;
                if (inFrame) return (
                  <p className="text-xs text-gray-500 mt-1">
                    Desktop pop-ups are not available inside the Shopify admin — completion sound will still play.
                  </p>
                );
                if (window.Notification && Notification.permission === "denied") return (
                  <p className="text-xs text-amber-600 mt-1 font-medium">
                    Notifications are blocked in your browser. Click the lock icon in the address bar to allow them.
                  </p>
                );
                return null;
              })()}
            </div>
            <Toggle checked={!!prefs.notifyOnComplete} onChange={(v) => {
              if (v && typeof window !== "undefined" && window.Notification && Notification.permission === "default") {
                Notification.requestPermission();
              }
              update({ notifyOnComplete: v });
            }} />
          </div>

          {/* Sound */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">Completion sound</p>
              <p className="text-xs text-gray-500 mt-1">
                Play a short chime when a job completes. Works even when the tab is in the background.
              </p>
            </div>
            <Toggle checked={!!prefs.notifySound} onChange={(v) => update({ notifySound: v })} />
          </div>
        </section>

        {/* ── Help & Support ── */}
        <section className="space-y-4">
          <div className="flex items-end justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900 flex items-center gap-1.5" style={{ fontFamily: F }}>
                Help &amp; Support
              </h2>
              <p className="text-sm text-gray-500 mt-0.5">Talk to a real human — usually within a few hours.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <SupportAction
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                </svg>
              }
              title="Email Support"
              description="Send us a message and we'll reply directly. Great for detailed questions."
              actionLabel="Open email"
              href={mailtoLink("Importzo — Support request")}
            />

            <SupportAction
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.068.157 2.148.279 3.238.364.466.037.893.281 1.153.671l1.72 2.58a.75.75 0 001.248 0l1.72-2.58a2.25 2.25 0 011.152-.67c1.09-.086 2.17-.208 3.238-.365 1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                </svg>
              }
              title="Live Chat"
              description="Open the chat bubble in the bottom-right for instant replies during business hours."
              actionLabel="Start chat"
              onClick={openLiveChat}
            />

            <SupportAction
              icon={
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
              }
              title="Report an Issue"
              description="Hit a bug or unexpected error? Share the details and we'll investigate fast."
              actionLabel="Report now"
              href={mailtoLink(
                "Importzo — Report an issue",
                "Hi Importzo team,\n\nI ran into an issue while using the app.\n\nWhat I was doing:\n\nWhat happened:\n\nStore URL:\n\nThanks!"
              )}
            />
          </div>

          {/* Contact summary card */}
          <DecorativeBanner cornerPosition="bottom-right" className="p-5">
            <div className="flex items-center gap-4 flex-wrap">
              <div
                className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-white"
                style={{ color: P }}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-gray-900">Direct contact</p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Email us anytime at{" "}
                  <a href={mailtoLink()} className="font-semibold" style={{ color: S }}>{SUPPORT_EMAIL}</a>
                </p>
              </div>
            </div>
          </DecorativeBanner>
        </section>

        {/* ── Attribution ── */}
        <div className="pt-2 border-t border-gray-100 flex items-center justify-center gap-1.5">
          <svg className="w-3 h-3" style={{ color: S }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.455 2.456L21.75 6l-1.036.259a3.375 3.375 0 00-2.455 2.456z" />
          </svg>
          <p className="text-[11px] text-gray-400">
            Importzo is built by{" "}
            <a href="https://dazzletech.co" target="_blank" rel="noopener noreferrer" className="font-semibold hover:underline" style={{ color: S }}>
              dazzletech.co
            </a>
          </p>
        </div>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <FriendlyErrorBoundary
      heading="Settings"
      title="We couldn't load Settings"
      message="Please try again. You can still reach us directly at support@dazzletech.co."
      error={error}
    />
  );
}
export const headers = (headersArgs) => boundary.headers(headersArgs);
