// ═══════════════════════════════════════════════════════════════════
// Shared UI Components — Importzo Design System
// Reusable across all import/export/transfer flows
// ═══════════════════════════════════════════════════════════════════

import PropTypes from "prop-types";

const P = "#17320A";
const S = "#2E6316";
const F = "'ImportzoFont', sans-serif";

// ── Status Badge ──
// Unified status rendering: "success" | "error" | "warning" | "info" | "pending" | "protected"
const STATUS_STYLES = {
  success:   { bg: "bg-green-50",  text: "text-green-700",  border: "border-green-200", dot: "bg-green-500" },
  error:     { bg: "bg-red-50",    text: "text-red-700",    border: "border-red-200",   dot: "bg-red-500" },
  warning:   { bg: "bg-amber-50",  text: "text-amber-700",  border: "border-amber-200", dot: "bg-amber-500" },
  info:      { bg: "bg-blue-50",   text: "text-blue-700",   border: "border-blue-200",  dot: "bg-blue-500" },
  pending:   { bg: "bg-gray-50",   text: "text-gray-500",   border: "border-gray-200",  dot: "bg-gray-400" },
  protected: { bg: "bg-gray-50",   text: "text-gray-500",   border: "border-gray-200",  dot: "bg-gray-400" },
};

export function StatusBadge({ status, label, showDot = true }) {
  const s = STATUS_STYLES[status] || STATUS_STYLES.pending;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${s.bg} ${s.text} border ${s.border}`}>
      {showDot && <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />}
      {label}
    </span>
  );
}

// ── Empty State ──
export function EmptyState({ icon, title, description, action }) {
  return (
    <div className="py-12 text-center">
      {icon && (
        <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-gray-900" style={{ fontFamily: F }}>{title}</h3>
      {description && <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ── Loading State ──
export function LoadingState({ message = "Loading...", size = "md" }) {
  const sz = size === "sm" ? "w-5 h-5" : size === "lg" ? "w-10 h-10" : "w-7 h-7";
  return (
    <div className="py-10 flex flex-col items-center gap-3">
      <svg className={`${sz} animate-spin`} style={{ color: P }} fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
      <p className="text-sm text-gray-500">{message}</p>
    </div>
  );
}

// ── Error Banner ──
export function ErrorBanner({ title = "Something went wrong", message, onDismiss, onRetry }) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-xl px-5 py-4 flex items-start gap-3">
      <svg className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-red-800">{title}</p>
        {message && <p className="text-sm text-red-700 mt-0.5">{message}</p>}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {onRetry && (
          <button onClick={onRetry} className="text-xs font-medium text-red-700 hover:text-red-900 px-2 py-1 rounded hover:bg-red-100 transition-colors">
            Retry
          </button>
        )}
        {onDismiss && (
          <button onClick={onDismiss} className="text-red-400 hover:text-red-600">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        )}
      </div>
    </div>
  );
}

// ── Success Banner ──
export function SuccessBanner({ message, onDismiss }) {
  return (
    <div className="bg-green-50 border border-green-200 rounded-xl px-5 py-4 flex items-center gap-3">
      <svg className="w-5 h-5 text-green-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      <p className="text-sm font-medium text-green-800 flex-1">{message}</p>
      {onDismiss && (
        <button onClick={onDismiss} className="text-green-400 hover:text-green-600">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
        </button>
      )}
    </div>
  );
}

// ── Confirm Dialog ──
// Inline confirmation for destructive actions (not a modal — stays in flow)
export function ConfirmDialog({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel", variant = "danger", onConfirm, onCancel }) {
  const btnStyle = variant === "danger"
    ? "bg-red-600 hover:bg-red-700 text-white"
    : `text-white hover:brightness-110`;
  return (
    <div className="rounded-xl border-2 border-amber-200 bg-amber-50/50 p-5">
      <div className="flex items-start gap-3">
        <svg className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-amber-900">{title}</p>
          {message && <p className="text-sm text-amber-800 mt-1">{message}</p>}
          <div className="flex items-center gap-2 mt-3">
            <button onClick={onConfirm}
              style={variant !== "danger" ? { background: P } : undefined}
              className={`px-4 py-1.5 text-sm font-medium rounded-lg transition-all ${btnStyle}`}>
              {confirmLabel}
            </button>
            <button onClick={onCancel} className="px-4 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50">
              {cancelLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── File Source Picker ──
// Extensible file source selection: local upload, Google Drive (placeholder), saved templates
export function FileSourcePicker({ onFileSelected, onSourceChange, accept = ".csv", disabled = false }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      {/* Local upload — active */}
      <label className={`group flex flex-col items-center gap-2 p-5 rounded-xl border-2 border-dashed transition-all cursor-pointer ${disabled ? "opacity-50 cursor-not-allowed border-gray-200" : "border-gray-300 hover:border-green-600 hover:bg-green-50/30"}`}>
        <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ background: "rgba(23,50,10,0.08)", color: S }}>
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
          </svg>
        </div>
        <span className="text-sm font-semibold text-gray-900">Upload from Computer</span>
        <span className="text-xs text-gray-500">CSV files supported</span>
        <input type="file" accept={accept} className="hidden" disabled={disabled}
          onChange={(e) => { if (e.target.files?.[0]) { onFileSelected(e.target.files[0]); onSourceChange?.("local"); } }} />
      </label>

      {/* Google Drive — not yet available */}
      <button
        disabled
        className="flex flex-col items-center gap-2 p-5 rounded-xl border-2 border-dashed border-gray-200 opacity-50 cursor-not-allowed"
        title="Google Drive integration is not available yet"
      >
        <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center">
          <svg className="w-5 h-5 text-gray-400" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7.71 3.5L1.15 15l3.43 5.95h6.88l-3.43-5.95L14.59 3.5H7.71zm2.16 3.74l3.87 6.71H6.88l3.87-6.71h-.88zM14.59 3.5l6.56 11.5-3.43 5.95h-6.88l3.43-5.95L7.71 3.5h6.88z" />
          </svg>
        </div>
        <span className="text-sm font-medium text-gray-400">Google Drive</span>
        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500">Not available</span>
      </button>

      {/* URL Import — not yet available */}
      <button
        disabled
        className="flex flex-col items-center gap-2 p-5 rounded-xl border-2 border-dashed border-gray-200 opacity-50 cursor-not-allowed"
        title="URL import is not available yet"
      >
        <div className="w-10 h-10 rounded-lg bg-gray-100 flex items-center justify-center">
          <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m13.35-.622l1.757-1.757a4.5 4.5 0 00-6.364-6.364l-4.5 4.5a4.5 4.5 0 001.242 7.244" />
          </svg>
        </div>
        <span className="text-sm font-medium text-gray-400">Import from URL</span>
        <span className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 text-gray-500">Not available</span>
      </button>
    </div>
  );
}

// ── AI Summary Card ──
// Displays a smart, contextual summary generated from import/export/transfer data.
// Designed to be populated by a helper function, not by a real AI API.
export function AISummary({ icon, title = "Smart Summary", items = [], variant = "info" }) {
  if (items.length === 0) return null;
  const borderColor = variant === "success" ? "border-green-200" : variant === "warning" ? "border-amber-200" : "border-blue-200";
  const bgColor = variant === "success" ? "bg-green-50/50" : variant === "warning" ? "bg-amber-50/50" : "bg-blue-50/50";
  const iconColor = variant === "success" ? "text-green-600" : variant === "warning" ? "text-amber-600" : "text-blue-600";
  return (
    <div className={`rounded-xl border ${borderColor} ${bgColor} p-4`}>
      <div className="flex items-center gap-2 mb-2">
        {icon || (
          <svg className={`w-4 h-4 ${iconColor}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
          </svg>
        )}
        <span className="text-xs font-semibold text-gray-700 uppercase tracking-wider">{title}</span>
      </div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="text-sm text-gray-700 flex items-start gap-2">
            <span className="text-gray-400 mt-0.5">•</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── AI Summary Generator Helpers ──
// These produce plain-language summaries from raw data without needing an LLM.

export function generateMappingSummary(headers, mapping, confidence, confirmed, requiredFields = []) {
  const items = [];
  const mapped = Object.values(mapping).filter(Boolean).length;
  const total = headers.length;
  const autoMapped = Object.keys(mapping).filter((i) => mapping[i] && !confirmed.has(i)).length;
  const userConfirmed = confirmed.size;
  const needsReview = Object.keys(mapping).filter((i) => mapping[i] && !confirmed.has(i) && (confidence[i] || 0) < 85).length;
  const missing = requiredFields.filter((f) => !Object.values(mapping).includes(f));

  if (mapped === total && missing.length === 0) {
    items.push("Your file is fully mapped and ready to import.");
  } else if (mapped > 0) {
    items.push(`${mapped} of ${total} columns mapped${autoMapped > 0 ? ` (${autoMapped} auto-detected)` : ""}.`);
  }
  if (userConfirmed > 0) items.push(`${userConfirmed} field${userConfirmed !== 1 ? "s" : ""} manually confirmed.`);
  if (needsReview > 0) items.push(`${needsReview} mapping${needsReview !== 1 ? "s" : ""} have lower confidence — review recommended.`);
  if (missing.length > 0) items.push(`Missing required field${missing.length !== 1 ? "s" : ""}: ${missing.join(", ")}.`);
  if (total - mapped > 0 && missing.length === 0) items.push(`${total - mapped} column${total - mapped !== 1 ? "s" : ""} will be skipped.`);

  const variant = missing.length > 0 ? "warning" : needsReview > 0 ? "info" : "success";
  return { items, variant };
}

export function generateImportResultSummary(successCount, errorCount, totalRows, importType = "records") {
  const items = [];
  if (errorCount === 0) {
    items.push(`All ${successCount} ${importType} imported successfully.`);
    items.push("No errors or warnings detected.");
  } else if (successCount > 0) {
    items.push(`${successCount} of ${totalRows} ${importType} imported successfully.`);
    items.push(`${errorCount} ${importType} failed — review the error details below for specific issues.`);
    items.push("You can retry failed items by re-importing only the rows that had errors.");
  } else {
    items.push(`Import failed — none of the ${totalRows} ${importType} could be processed.`);
    items.push("Check that your file format matches the expected structure and required fields are present.");
  }
  const variant = errorCount === 0 ? "success" : successCount > 0 ? "warning" : "error";
  return { items, variant };
}

export function generateTransferResultSummary(results) {
  const items = [];
  const modules = Object.keys(results);
  let totalSuccess = 0, totalErrors = 0;

  for (const key of modules) {
    const r = results[key];
    if (key === "collections" && r?.items) {
      const prods = r.items.flatMap((c) => c.products || []);
      totalSuccess += prods.filter((p) => p.status === "success").length;
      totalErrors += prods.filter((p) => p.status === "error").length;
    } else if (r?.results) {
      totalSuccess += r.results.filter((x) => x.status === "success").length;
      totalErrors += r.results.filter((x) => x.status === "error").length;
    }
  }

  if (totalErrors === 0 && totalSuccess > 0) {
    items.push(`Transfer completed successfully — ${totalSuccess} items across ${modules.length} module${modules.length !== 1 ? "s" : ""}.`);
  } else if (totalSuccess > 0) {
    items.push(`${totalSuccess} items transferred, ${totalErrors} failed across ${modules.length} module${modules.length !== 1 ? "s" : ""}.`);
    items.push("Review failed items below. You can retry failed modules individually.");
  } else if (totalErrors > 0) {
    items.push("Transfer encountered errors for all items. Check your source store connection and permissions.");
  }
  const variant = totalErrors === 0 ? "success" : totalSuccess > 0 ? "warning" : "error";
  return { items, variant };
}

StatusBadge.propTypes = {
  status: PropTypes.string,
  label: PropTypes.string,
  showDot: PropTypes.bool,
};

EmptyState.propTypes = {
  icon: PropTypes.node,
  title: PropTypes.string,
  description: PropTypes.string,
  action: PropTypes.node,
};

LoadingState.propTypes = {
  message: PropTypes.string,
  size: PropTypes.string,
};

ErrorBanner.propTypes = {
  title: PropTypes.string,
  message: PropTypes.string,
  onDismiss: PropTypes.func,
  onRetry: PropTypes.func,
};

SuccessBanner.propTypes = {
  message: PropTypes.string,
  onDismiss: PropTypes.func,
};

ConfirmDialog.propTypes = {
  title: PropTypes.string,
  message: PropTypes.string,
  confirmLabel: PropTypes.string,
  cancelLabel: PropTypes.string,
  variant: PropTypes.string,
  onConfirm: PropTypes.func,
  onCancel: PropTypes.func,
};

FileSourcePicker.propTypes = {
  onFileSelected: PropTypes.func,
  onSourceChange: PropTypes.func,
  accept: PropTypes.string,
  disabled: PropTypes.bool,
};

AISummary.propTypes = {
  icon: PropTypes.node,
  title: PropTypes.string,
  items: PropTypes.arrayOf(PropTypes.string),
  variant: PropTypes.string,
};
