// ═══════════════════════════════════════════════════════════════════
// Scheduled sync — the merchant-facing screen.
//
// WHY THIS EXISTS
//
// Everything behind this page already worked: api.scheduled-sync.jsx has full
// CRUD, scheduler.server.js computes the cadence, the tick in
// api.scheduler-tick.jsx fires the jobs, and the plan gate has been enforced
// server-side since Phase 5. All of it is covered by tests.
//
// What was missing was the front door. Scheduled sync is sold as a reason to
// buy Pro in six separate places — the plan tagline, the plan description, the
// billing feature list, the marketing page's pricing card, its FAQ, and its
// schema.org product data — and the dashboard actively pushes an upgrade for
// it. There was no way for a merchant to create one, and the production table
// held zero rows, which is what you would expect of a feature nobody could
// reach. A paid plan has to be able to deliver what it charges for.
//
// PLAN GATING
//
// Built for Shopify 4.3.7 requires plan-gated features to be disabled "both
// visually and functionally" and clearly indicated — not merely refused after
// the merchant has filled the form in. So on Free the fieldset is genuinely
// `disabled` (the browser blocks focus and submission), the card is dimmed,
// and the reason plus an upgrade link sit above it. The server keeps its own
// check regardless: this UI is a courtesy, never the security boundary.
// ═══════════════════════════════════════════════════════════════════

import { useEffect, useState } from "react";
import { useFetcher, useLoaderData, Link } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getUsageStatus } from "../lib/usage.server";
import { getSavedSourceStore } from "../lib/safe-db";
import { BRAND, FREQUENCY } from "../lib/constants";
import { PLANS, PLAN_IDS } from "../lib/plans";

const P = BRAND.primary, S = BRAND.secondary, F = BRAND.font;

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// Same shape api.scheduled-sync.jsx returns — token columns are never selected.
const SAFE_FIELDS = {
  id: true, sourceShop: true, frequency: true, hourUtc: true, dayOfWeek: true,
  conflictMode: true, enabled: true, nextRunAt: true, lastRunAt: true,
  lastError: true, consecutiveFailures: true, disabledReason: true, createdAt: true,
};

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const [schedules, usage, saved] = await Promise.all([
    prisma.scheduledSync.findMany({
      where: { shop: session.shop }, orderBy: { createdAt: "desc" }, select: SAFE_FIELDS,
    }),
    getUsageStatus({ prisma, shop: session.shop }),
    getSavedSourceStore(session.shop).catch(() => null),
  ]);

  return {
    schedules: schedules.map((s) => ({
      ...s,
      nextRunAt: s.nextRunAt ? new Date(s.nextRunAt).toISOString() : null,
      lastRunAt: s.lastRunAt ? new Date(s.lastRunAt).toISOString() : null,
      createdAt: new Date(s.createdAt).toISOString(),
    })),
    allowed: usage.scheduledSyncAllowed,
    planLabel: usage.label,
    // The token itself is deliberately not sent to the browser; the API reads
    // the saved connection server-side when no credentials are posted.
    savedSource: saved ? saved.sourceUrl : null,
  };
};

const fmt = (iso) =>
  iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—";

function cadenceLabel(s) {
  const at = `${String(s.hourUtc).padStart(2, "0")}:00 UTC`;
  if (s.frequency === FREQUENCY.HOURLY) return "Every hour";
  if (s.frequency === FREQUENCY.WEEKLY) return `Every ${DAYS[s.dayOfWeek ?? 0]} at ${at}`;
  return `Every day at ${at}`;
}

export default function ScheduledSyncPage() {
  const { schedules, allowed, planLabel, savedSource } = useLoaderData();
  const fetcher = useFetcher();
  const [frequency, setFrequency] = useState(FREQUENCY.DAILY);
  const busy = fetcher.state !== "idle";
  const error = fetcher.data && fetcher.data.ok === false ? fetcher.data.error : null;

  // The API is a sibling route, so a successful write needs the loader re-run
  // to show the new list.
  const revalidate = fetcher.data?.ok;
  useEffect(() => {
    if (revalidate) fetcher.load("/app/scheduled-sync");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revalidate]);

  const post = (fields) => {
    const fd = new FormData();
    Object.entries(fields).forEach(([k, v]) => fd.append(k, String(v)));
    fetcher.submit(fd, { method: "post", action: "/api/scheduled-sync" });
  };

  const canCreate = allowed && !!savedSource;

  return (
    <s-page heading="Scheduled sync" backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}>
      <div className="space-y-6 animate-fade-in">

        <p className="text-sm text-gray-600 max-w-2xl">
          Re-run a store transfer automatically on a schedule. Each run copies from your
          connected source store into this store, using the conflict handling you pick here.
        </p>

        {/* ── Plan gate ───────────────────────────────────────────── */}
        {!allowed && (
          <div className="rounded-xl border p-4 flex items-start gap-3"
            style={{ borderColor: "rgba(46,99,22,0.25)", background: "rgba(46,99,22,0.04)" }}>
            <span className="text-xs font-semibold px-2 py-1 rounded-full flex-shrink-0"
              style={{ background: S, color: "#fff" }}>Pro feature</span>
            <div className="min-w-0">
              <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>
                Scheduled sync isn&apos;t included on {planLabel}
              </p>
              <p className="text-xs text-gray-600 mt-0.5">
                Available on Pro and Agency — from ${PLANS[PLAN_IDS.PRO].price}/month.{" "}
                <Link to="/app/billing" className="font-semibold hover:underline" style={{ color: S }}>
                  View plans
                </Link>
              </p>
            </div>
          </div>
        )}

        {allowed && !savedSource && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
            <p className="text-sm font-semibold text-amber-900">Connect a source store first</p>
            <p className="text-xs text-amber-800 mt-0.5">
              A schedule copies from a source store, so there has to be one saved.{" "}
              <Link to="/app/transfer" className="font-semibold underline">Set one up on Transfer Store</Link>,
              then come back.
            </p>
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-4">
            <p className="text-sm font-semibold text-red-800">Couldn&apos;t save that schedule</p>
            <p className="text-xs text-red-700 mt-0.5">{error}</p>
          </div>
        )}

        {/* ── Create ──────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden"
          style={{ opacity: canCreate ? 1 : 0.55 }}>
          <div className="px-5 py-3 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>New schedule</p>
            {savedSource && (
              <p className="text-xs text-gray-500 mt-0.5">
                Source: <span className="font-medium text-gray-700">{savedSource}</span>
              </p>
            )}
          </div>

          {/* `disabled` on the fieldset is what makes the gate real: the browser
              blocks focus and submission for everything inside it. */}
          <fieldset disabled={!canCreate} className="px-5 py-4 border-0 m-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <label className="block">
                <span className="text-xs font-medium text-gray-700">How often</span>
                <select name="frequency" value={frequency} onChange={(e) => setFrequency(e.target.value)}
                  className="mt-1 w-full text-sm rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-50">
                  <option value={FREQUENCY.DAILY}>Daily</option>
                  <option value={FREQUENCY.WEEKLY}>Weekly</option>
                  <option value={FREQUENCY.HOURLY}>Hourly</option>
                </select>
              </label>

              <label className="block" style={{ visibility: frequency === FREQUENCY.HOURLY ? "hidden" : "visible" }}>
                <span className="text-xs font-medium text-gray-700">At (UTC)</span>
                <select name="hourUtc" defaultValue="3"
                  className="mt-1 w-full text-sm rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-50">
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>
                  ))}
                </select>
              </label>

              <label className="block" style={{ visibility: frequency === FREQUENCY.WEEKLY ? "visible" : "hidden" }}>
                <span className="text-xs font-medium text-gray-700">On</span>
                <select name="dayOfWeek" defaultValue="0"
                  className="mt-1 w-full text-sm rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-50">
                  {DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
                </select>
              </label>

              <label className="block">
                <span className="text-xs font-medium text-gray-700">If a product already exists</span>
                <select name="conflictMode" defaultValue="skip"
                  className="mt-1 w-full text-sm rounded-lg border border-gray-300 px-3 py-2 disabled:bg-gray-50">
                  <option value="skip">Skip it</option>
                  <option value="update">Update it</option>
                  <option value="overwrite">Overwrite it</option>
                </select>
              </label>
            </div>

            <button
              type="button"
              disabled={!canCreate || busy}
              onClick={(e) => {
                const fs = e.currentTarget.closest("fieldset");
                const get = (n) => fs.querySelector(`[name="${n}"]`)?.value;
                post({
                  intent: "create",
                  frequency: get("frequency"),
                  hourUtc: get("hourUtc") ?? 3,
                  dayOfWeek: get("dayOfWeek") ?? 0,
                  conflictMode: get("conflictMode"),
                });
              }}
              className="mt-4 px-5 py-2.5 text-sm rounded-lg text-white font-semibold transition-all hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
              style={{ background: P, fontFamily: F }}
            >
              {busy ? "Saving…" : "Create schedule"}
            </button>
          </fieldset>
        </div>

        {/* ── Existing ────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-3 border-b border-gray-100">
            <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>
              Your schedules
            </p>
          </div>

          {schedules.length === 0 ? (
            <div className="px-5 py-10 text-center">
              <p className="text-sm font-medium text-gray-700">No schedules yet</p>
              <p className="text-xs text-gray-400 mt-1">
                {canCreate
                  ? "Create one above and it will run without you having to open the app."
                  : "Once scheduled sync is available on your plan, you can set one up here."}
              </p>
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {schedules.map((s) => (
                <li key={s.id} className="px-5 py-4 flex items-start justify-between gap-4 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-gray-900">{cadenceLabel(s)}</p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      From {s.sourceShop} · conflicts: {s.conflictMode} · next run {fmt(s.nextRunAt)}
                    </p>
                    {s.lastRunAt && (
                      <p className="text-xs text-gray-400 mt-0.5">Last run {fmt(s.lastRunAt)}</p>
                    )}
                    {s.disabledReason && (
                      <p className="text-xs text-amber-800 mt-1">Disabled: {s.disabledReason}</p>
                    )}
                    {s.lastError && !s.disabledReason && (
                      <p className="text-xs text-red-700 mt-1">Last error: {s.lastError}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0">
                    <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${
                      s.enabled ? "bg-green-50 text-green-700" : "bg-gray-100 text-gray-600"}`}>
                      {s.enabled ? "Active" : "Paused"}
                    </span>
                    <button
                      type="button" disabled={busy}
                      onClick={() => post({ intent: "update", id: s.id, enabled: String(!s.enabled) })}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-gray-300 hover:bg-gray-50 disabled:opacity-50"
                    >
                      {s.enabled ? "Pause" : "Resume"}
                    </button>
                    <button
                      type="button" disabled={busy}
                      onClick={() => post({ intent: "delete", id: s.id })}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg text-red-700 border border-red-200 hover:bg-red-50 disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </s-page>
  );
}
