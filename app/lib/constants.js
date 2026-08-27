// ═══════════════════════════════════════════════════════════════════
// Importzo — Shared Constants
// Centralized brand, job types, and status configuration.
// ═══════════════════════════════════════════════════════════════════

export const BRAND = {
  primary: "#17320A",
  secondary: "#2E6316",
  font: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
};

// Job type config — used in dashboard, activity, and hub pages
export const JOB_TYPE_CONFIG = {
  products:    { label: "Products",    bg: "bg-green-50",   text: "text-green-700",   route: "/app/product-importer" },
  collections: { label: "Collections", bg: "bg-purple-50",  text: "text-purple-700",  route: "/app/collections" },
  inventory:   { label: "Inventory",   bg: "bg-amber-50",   text: "text-amber-700",   route: "/app/inventory" },
  transfer:    { label: "Transfer",    bg: "bg-indigo-50",  text: "text-indigo-700",  route: "/app/transfer" },
};

// Import job status badges — used in dashboard and activity
export const JOB_STATUS_MAP = {
  completed:            { dot: "bg-green-500",                bg: "bg-green-50", text: "text-green-700", label: "Completed" },
  completed_with_errors:{ dot: "bg-amber-500",                bg: "bg-amber-50", text: "text-amber-700", label: "Partial" },
  failed:               { dot: "bg-red-500",                  bg: "bg-red-50",   text: "text-red-700",   label: "Failed" },
  pending:              { dot: "bg-gray-400",                 bg: "bg-gray-50",  text: "text-gray-600",  label: "Pending" },
  importing:            { dot: "bg-green-500 animate-pulse",  bg: "bg-green-50", text: "text-green-700", label: "Running" },
};
