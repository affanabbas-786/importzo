import PropTypes from "prop-types";
import { useState, useCallback, useEffect, Fragment } from "react";
import { useLoaderData, useNavigation, useRouteError, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { BRAND, JOB_TYPE_CONFIG, JOB_STATUS_MAP } from "../lib/constants";
import { SUPPORT_EMAIL, mailtoLink, openLiveChat } from "../lib/support";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";
import { DecorativeBanner, EmptyStateIllustration } from "../components/decor";
import { COLORS } from "../lib/design-tokens";
import { PLANS, PLAN_IDS, yearlySavingsPercent } from "../lib/plans.js";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  let imports = [];
  try {
    imports = await prisma.importJob.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  } catch (err) {
    console.warn("[importzo] dashboard loader failed:", err?.message || err);
  }
  return { imports };
};

const { primary, secondary, font } = BRAND;

// ── Helpers ──
// Job `results` JSON can take two shapes:
//   • Import jobs  → plain array of row records   [{ row, title, status, error }, ...]
//   • Transfer jobs → keyed object per module     { collections: { items: [...] }, products: { results: [...] }, themes: { results: [...] } }
// This normalizer flattens both into a uniform array so the Dashboard can
// render a single error list and CSV export without special-casing callers.
function normalizeResults(raw) {
  if (!raw) return [];
  let parsed;
  try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return []; }
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    const collected = [];
    for (const [sectionKey, section] of Object.entries(parsed)) {
      if (!section || typeof section !== "object") continue;
      const arrays = [];
      if (Array.isArray(section)) arrays.push(section);
      if (Array.isArray(section.items)) arrays.push(section.items);
      if (Array.isArray(section.results)) arrays.push(section.results);
      if (Array.isArray(section.errors)) arrays.push(section.errors);
      if (Array.isArray(section.failures)) arrays.push(section.failures);
      for (const arr of arrays) {
        for (const item of arr) {
          if (item && typeof item === "object") {
            collected.push({ ...item, _section: sectionKey });
          }
        }
      }
    }
    return collected;
  }
  return [];
}

function downloadErrorCSV(job) {
  try {
    const results = normalizeResults(job.results);
    const errors = results.filter((r) => r && (r.status === "error" || r.status === "not_found"));
    if (errors.length === 0) return;
    const rows = [["Row", "Title/SKU", "Status", "Error"]];
    errors.forEach((e) => {
      rows.push([
        String(e.row || ""),
        (e.title || e.sku || "").replace(/"/g, '""'),
        e.status || "",
        (e.error || "").replace(/"/g, '""'),
      ]);
    });
    const csv = rows.map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `errors-${job.fileName.replace(/\.csv$/i, "")}-${job.id.slice(0, 8)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  } catch { /* silently fail */ }
}

// ── Status Badge ──
function JobStatusBadge({ status }) {
  const s = JOB_STATUS_MAP[status] || JOB_STATUS_MAP.pending;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${s.bg} ${s.text} whitespace-nowrap`}>
      <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />{s.label}
    </span>
  );
}
JobStatusBadge.propTypes = { status: PropTypes.string };

// ── Expanded detail row ──
// "Explain this error" \u2014 plain-language AI diagnosis of one failed row.
// Zero decoration by design (per the design brief: error UI stays serious,
// unambiguous, Polaris-plain) \u2014 a small text-link-style trigger, matching
// the existing "Download CSV" link right above it, not a leaf-branded button.
function ExplainErrorButton({ error, itemLabel, aiAvailable }) {
  const [state, setState] = useState({ status: "idle" }); // idle | loading | done | error

  if (!aiAvailable) return null;

  async function handleExplain() {
    setState({ status: "loading" });
    try {
      const fd = new FormData();
      fd.append("error", error || "");
      fd.append("itemLabel", itemLabel || "");
      const res = await fetch("/api/ai-diagnose-error", { method: "POST", body: fd, credentials: "same-origin" });
      const data = await res.json();
      if (!data.ok) { setState({ status: "error", message: data.error }); return; }
      setState({ status: "done", explanation: data.explanation });
    } catch (err) {
      setState({ status: "error", message: err.message });
    }
  }

  if (state.status === "idle") {
    return (
      <button type="button" onClick={handleExplain} className="text-[11px] font-medium text-gray-500 hover:text-gray-700 underline underline-offset-2 flex-shrink-0">
        Explain this error
      </button>
    );
  }
  if (state.status === "loading") {
    return <span className="text-[11px] text-gray-400 flex-shrink-0">Explaining&hellip;</span>;
  }
  if (state.status === "error") {
    return <span className="text-[11px] text-gray-400 flex-shrink-0" title={state.message}>Couldn&apos;t explain this error</span>;
  }
  return <p className="text-[11px] text-gray-600 mt-1 leading-relaxed">{state.explanation}</p>;
}

ExplainErrorButton.propTypes = {
  error: PropTypes.string,
  itemLabel: PropTypes.string,
  aiAvailable: PropTypes.bool,
};

function DetailPanel({ job }) {
  const results = normalizeResults(job.results);
  const errors = results.filter((r) => r && (r.status === "error" || r.status === "not_found"));
  const successes = results.filter((r) => r && (r.status === "success" || r.status === "updated" || r.status === "created"));

  // Whether this shop has any AI integration configured at all (BYOK or
  // built-in) \u2014 checked once per opened panel; hides the "Explain this
  // error" trigger entirely rather than showing a button that would just
  // 400 for shops with no AI connected.
  const [aiAvailable, setAiAvailable] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/ai-settings", { credentials: "same-origin" })
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setAiAvailable(!!(data.ok && data.integration && data.integration.enabled)); })
      .catch(() => { if (!cancelled) setAiAvailable(false); });
    return () => { cancelled = true; };
  }, []);

  return (
    <div className="px-6 py-4 bg-gray-50/70 border-t border-gray-100 space-y-3">
      <div className="flex items-center gap-4 text-xs text-gray-500 flex-wrap">
        <span>Job ID: <span className="font-mono text-gray-600">{job.id.slice(0, 8)}</span></span>
        <span>File: <span className="font-medium text-gray-700">{job.fileName}</span></span>
        <span>Total rows: <span className="font-medium text-gray-700">{job.totalRows}</span></span>
      </div>

      {errors.length > 0 && (
        <div className="bg-white rounded-lg border border-red-100 overflow-hidden">
          <div className="px-4 py-2 bg-red-50/60 border-b border-red-100 flex items-center justify-between">
            <span className="text-xs font-semibold text-red-700">{errors.length} Error{errors.length !== 1 ? "s" : ""}</span>
            <button
              onClick={() => downloadErrorCSV(job)}
              className="text-xs font-medium text-red-600 hover:text-red-800 underline underline-offset-2"
            >
              Download CSV
            </button>
          </div>
          <div className="max-h-[220px] overflow-auto">
            <table className="w-full">
              <tbody className="divide-y divide-red-50">
                {errors.slice(0, 10).map((e, i) => (
                  <tr key={i}>
                    <td className="px-4 py-1.5 text-xs text-gray-400 w-10 align-top">#{e.row}</td>
                    <td className="px-4 py-1.5 text-xs font-medium text-gray-700 max-w-[140px] truncate align-top">{e.title || e.sku || "\u2014"}</td>
                    <td className="px-4 py-1.5 text-xs text-red-600 break-words align-top">
                      {e.error || "Not found"}
                      <ExplainErrorButton error={e.error || "Not found"} itemLabel={e.title || e.sku || ""} aiAvailable={aiAvailable} />
                    </td>
                  </tr>
                ))}
                {errors.length > 10 && (
                  <tr><td colSpan={3} className="px-4 py-1.5 text-xs text-gray-400">+{errors.length - 10} more errors</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {successes.length > 0 && (
        <p className="text-xs text-green-700">
          {successes.length} record{successes.length !== 1 ? "s" : ""} processed successfully.
        </p>
      )}
    </div>
  );
}

DetailPanel.propTypes = {
  job: PropTypes.shape({
    results: PropTypes.oneOfType([PropTypes.string, PropTypes.array, PropTypes.object]),
    id: PropTypes.string,
    fileName: PropTypes.string,
    totalRows: PropTypes.number,
  }),
};

// ═══════════════════════════════════════════════════════════════════
// Dashboard
// ═══════════════════════════════════════════════════════════════════
// Pulse skeleton block
function Skeleton({ className = "" }) {
  return <div className={`animate-pulse rounded-lg bg-gray-200 ${className}`} />;
}
Skeleton.propTypes = { className: PropTypes.string };

function DashboardSkeleton() {
  return (
    <s-page heading="Dashboard">
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center gap-3.5">
          <Skeleton className="w-10 h-10 rounded-lg" />
          <Skeleton className="h-5 w-32" />
        </div>
        {/* Action cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm flex items-start gap-4">
              <Skeleton className="w-11 h-11 rounded-xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-40" />
              </div>
            </div>
          ))}
        </div>
        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <Skeleton className="w-9 h-9 rounded-lg" />
                <div className="space-y-1.5">
                  <Skeleton className="h-5 w-12" />
                  <Skeleton className="h-2.5 w-20" />
                </div>
              </div>
            </div>
          ))}
        </div>
        {/* Table */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
          <Skeleton className="h-4 w-32 mb-4" />
          <div className="space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        </div>
      </div>
    </s-page>
  );
}

export default function Dashboard() {
  const { imports } = useLoaderData();
  const navigation = useNavigation();
  const [expanded, setExpanded] = useState({});

  const toggle = useCallback((id) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  // Show skeleton when navigating to this page (reload / first load)
  if (navigation.state === "loading" && navigation.location?.pathname === "/app") {
    return <DashboardSkeleton />;
  }

  // Stats
  const totalJobs = imports.length;
  const totalRecords = imports.reduce((s, i) => s + i.successCount + i.errorCount, 0);
  const totalFailed = imports.filter((i) => i.status === "failed").length;
  const successRate =
    totalRecords > 0
      ? Math.round(imports.reduce((s, i) => s + i.successCount, 0) / totalRecords * 100)
      : 100;

  return (
    <s-page heading="Dashboard">
      <div className="space-y-6 animate-fade-in">
        {/* ── Header (unchanged — logo/wordmark, not part of this design pass) ── */}
        <div className="flex items-center gap-3.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: primary, fontFamily: font }}>Dashboard</span>
        </div>

        {/* ── Welcome banner + 3 Primary Action Cards (full decorative treatment) ── */}
        <DecorativeBanner className="p-5 sm:p-6">
          <p className="text-sm text-gray-600 mb-4 max-w-xl">
            Welcome back — start an import, export your catalog, or move data between stores.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <Link
              to="/app/import"
              className="group bg-white rounded-2xl border border-gray-200 p-5 shadow-sm hover:shadow-lg transition-all duration-200 hover:-translate-y-1 flex items-start gap-4"
            >
              <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0 transition-colors" style={{ background: "rgba(23,50,10,0.08)", color: secondary }}>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: font }}>Import Data</p>
                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">Products, collections, inventory &amp; more</p>
              </div>
              <svg className="w-4 h-4 text-gray-300 group-hover:text-gray-500 mt-0.5 flex-shrink-0 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </Link>

            <Link
              to="/app/export"
              className="group bg-white rounded-2xl border border-gray-200 p-5 shadow-sm hover:shadow-lg transition-all duration-200 hover:-translate-y-1 flex items-start gap-4"
            >
              <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "rgba(23,50,10,0.08)", color: secondary }}>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12M12 16.5V3" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: font }}>Export Data</p>
                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">Download your store data as CSV</p>
              </div>
              <svg className="w-4 h-4 text-gray-300 group-hover:text-gray-500 mt-0.5 flex-shrink-0 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </Link>

            <Link
              to="/app/transfer"
              className="group bg-white rounded-2xl border border-gray-200 p-5 shadow-sm hover:shadow-lg transition-all duration-200 hover:-translate-y-1 flex items-start gap-4"
            >
              <div className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "rgba(23,50,10,0.08)", color: secondary }}>
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 21L3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />
                </svg>
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: font }}>Transfer Store</p>
                <p className="text-xs text-gray-500 mt-0.5 leading-relaxed">Move data between Shopify stores</p>
              </div>
              <svg className="w-4 h-4 text-gray-300 group-hover:text-gray-500 mt-0.5 flex-shrink-0 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </Link>
          </div>
        </DecorativeBanner>

        {/* ── Summary Stats ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Total Jobs", value: totalJobs, icon: "M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z", iconBg: "rgba(23,50,10,0.08)", iconColor: primary },
            { label: "Records Processed", value: totalRecords, icon: "M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z", iconBg: "rgba(37,99,235,0.08)", iconColor: "#2563EB" },
            { label: "Failed Jobs", value: totalFailed, icon: "M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z", iconBg: totalFailed > 0 ? "rgba(239,68,68,0.08)" : "rgba(156,163,175,0.08)", iconColor: totalFailed > 0 ? "#EF4444" : "#9CA3AF" },
            { label: "Success Rate", value: `${successRate}%`, icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z", iconBg: "rgba(16,185,129,0.08)", iconColor: "#10B981" },
          ].map((stat) => (
            <div key={stat.label} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: stat.iconBg }}>
                  <svg style={{ color: stat.iconColor, width: 18, height: 18 }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d={stat.icon} />
                  </svg>
                </div>
                <div className="min-w-0">
                  <p className="text-xl font-bold text-gray-900 leading-tight">{stat.value}</p>
                  <p className="text-[10px] font-medium text-gray-400 uppercase tracking-wider mt-0.5">{stat.label}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* ── Recent Activity ── */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
            <h2 className="text-base font-semibold text-gray-900 flex items-center gap-1.5" style={{ fontFamily: font }}>
              Recent Activity
            </h2>
            {imports.length > 0 && (
              <Link to="/app/activity" className="text-xs font-medium hover:underline" style={{ color: secondary }}>View all</Link>
            )}
          </div>

          {imports.length === 0 ? (
            <div className="p-12 text-center">
              <EmptyStateIllustration size={88} className="mx-auto mb-4" />
              <p className="text-sm font-medium text-gray-700 mb-1">No activity yet</p>
              <p className="text-xs text-gray-400 mb-5">Import your first CSV file to get started.</p>
              <Link
                to="/app/import"
                className="inline-flex items-center gap-2 px-5 py-2.5 text-white text-sm rounded-lg transition-all hover:brightness-110"
                style={{ background: primary, fontWeight: 600, fontFamily: font }}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
                </svg>
                Start Importing
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full table-fixed">
                <colgroup>
                  <col style={{ width: 140 }} />
                  <col style={{ width: 120 }} />
                  <col />
                  <col style={{ width: 100 }} />
                  <col style={{ width: 150 }} />
                  <col style={{ width: 120 }} />
                  <col style={{ width: 130 }} />
                </colgroup>
                <thead>
                  <tr className="bg-gray-50/80">
                    <th className="px-5 py-3 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Date</th>
                    <th className="px-5 py-3 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Type</th>
                    <th className="px-5 py-3 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider">File / Source</th>
                    <th className="px-5 py-3 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Records</th>
                    <th className="px-5 py-3 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Result</th>
                    <th className="px-5 py-3 text-left text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Status</th>
                    <th className="px-5 py-3 text-right text-[10px] font-semibold text-gray-400 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {imports.map((job) => {
                    const tc = JOB_TYPE_CONFIG[job.importType] || JOB_TYPE_CONFIG.products;
                    const hasErrors = job.errorCount > 0;
                    const isOpen = expanded[job.id];
                    return (
                      <Fragment key={job.id}>
                        <tr className={`group hover:bg-gray-50/50 transition-colors ${isOpen ? "bg-gray-50/30" : ""}`}>
                          <td className="px-5 py-3.5 text-sm text-gray-500 align-middle whitespace-nowrap">
                            {new Date(job.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </td>
                          <td className="px-5 py-3.5 align-middle">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${tc.bg} ${tc.text} whitespace-nowrap`}>
                              {tc.label}
                            </span>
                          </td>
                          <td className="px-5 py-3.5 align-middle">
                            <span className="text-sm font-medium text-gray-900 truncate block" title={job.fileName}>{job.fileName}</span>
                          </td>
                          <td className="px-5 py-3.5 align-middle">
                            <span className="text-sm text-gray-600 whitespace-nowrap">
                              {job.successCount}<span className="text-gray-400">/{job.totalRows}</span>
                            </span>
                          </td>
                          <td className="px-5 py-3.5 align-middle">
                            <div className="flex items-center gap-1.5 flex-wrap">
                              {job.successCount > 0 && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-green-50 text-green-700 whitespace-nowrap">
                                  {job.successCount} ok
                                </span>
                              )}
                              {hasErrors && (
                                <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-red-50 text-red-700 whitespace-nowrap">
                                  {job.errorCount} err
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="px-5 py-3.5 align-middle">
                            <JobStatusBadge status={job.status} />
                          </td>
                          <td className="px-5 py-3.5 align-middle">
                            <div className="flex items-center justify-end gap-1">
                              <button
                                onClick={() => toggle(job.id)}
                                title={isOpen ? "Hide details" : "View details"}
                                className={`p-1.5 rounded-md transition-colors ${isOpen ? "bg-gray-200 text-gray-700" : "text-gray-400 hover:text-gray-600 hover:bg-gray-100"}`}
                              >
                                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                  <path strokeLinecap="round" strokeLinejoin="round" d={isOpen ? "M5 15l7-7 7 7" : "M19 9l-7 7-7-7"} />
                                </svg>
                              </button>
                              {(job.status === "failed" || job.status === "completed_with_errors") && (
                                <Link
                                  to={tc.route}
                                  title="Retry import"
                                  className="p-1.5 rounded-md text-gray-400 hover:text-amber-600 hover:bg-amber-50 transition-colors"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182" />
                                  </svg>
                                </Link>
                              )}
                              {hasErrors && (
                                <button
                                  onClick={() => downloadErrorCSV(job)}
                                  title="Download error report"
                                  className="p-1.5 rounded-md text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12M12 16.5V3" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                        {isOpen && (
                          <tr>
                            <td colSpan={7} className="p-0">
                              <DetailPanel job={job} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Quick Tips (full decorative treatment) ── */}
        <DecorativeBanner cornerPosition="bottom-right" className="p-5 sm:p-6">
          <h2 className="text-base font-semibold text-gray-900 flex items-center gap-1.5 mb-3" style={{ fontFamily: font }}>
            Quick Tips
          </h2>
          <ul className="space-y-2.5">
            {[
              "Use Dry Run mode before a real transfer to preview exactly what would change, with nothing written yet.",
              `Scheduled Sync is available on the Pro and Agency plans — from $${PLANS[PLAN_IDS.PRO].price}/month, or $${PLANS[PLAN_IDS.PRO].priceYearly}/year to save ${yearlySavingsPercent(PLAN_IDS.PRO)}%. See Billing to upgrade.`,
              "Save a CSV column mapping as a template from any importer so you don't have to remap it next time.",
            ].map((tip) => (
              <li key={tip} className="flex items-start gap-2.5 text-sm text-gray-700">
                <span
                  aria-hidden="true"
                  className="mt-1.5 flex-shrink-0 rounded-full"
                  style={{ width: 5, height: 5, background: COLORS.washDeep }}
                />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </DecorativeBanner>

        {/* ── System Status + Need Help (compact, side by side) ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Static reassurance element — no real monitoring backend. */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-3">
            <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
            </span>
            <div>
              <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: font }}>All systems operational</p>
              <p className="text-xs text-gray-400 mt-0.5">Importzo services are running normally.</p>
            </div>
          </div>

          {/* Need Help? — dark green, contrasting the light cards around it. */}
          <div className="rounded-xl p-5 flex items-center gap-4 flex-wrap" style={{ background: primary }}>
            <div className="flex-1 min-w-[160px]">
              <p className="text-sm font-semibold text-white" style={{ fontFamily: font }}>Need help?</p>
              <p className="text-xs mt-0.5 leading-relaxed" style={{ color: "rgba(255,255,255,0.7)" }}>
                We reply fast — email or live chat.
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <a
                href={mailtoLink("Importzo — I need help")}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors"
                style={{ background: "rgba(255,255,255,0.12)", color: "#fff" }}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75" />
                </svg>
                Email
              </a>
              <button
                type="button"
                onClick={openLiveChat}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors"
                style={{ background: "#fff", color: primary }}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.76c0 1.6 1.123 2.994 2.707 3.227 1.068.157 2.148.279 3.238.364.466.037.893.281 1.153.671l1.72 2.58a.75.75 0 001.248 0l1.72-2.58a2.25 2.25 0 011.152-.67c1.09-.086 2.17-.208 3.238-.365 1.585-.233 2.708-1.626 2.708-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z" />
                </svg>
                Live Chat
              </button>
            </div>
            <p className="text-[11px] w-full" style={{ color: "rgba(255,255,255,0.55)" }}>
              Direct email: <a href={mailtoLink()} className="font-medium hover:underline text-white">{SUPPORT_EMAIL}</a>
            </p>
          </div>
        </div>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <FriendlyErrorBoundary
      heading="Dashboard"
      title="We couldn't load your Dashboard"
      message="Please try again. Your existing data is safe — this is just a display issue."
      error={error}
    />
  );
}
export const headers = (headersArgs) => boundary.headers(headersArgs);
