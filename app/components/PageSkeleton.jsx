// ═══════════════════════════════════════════════════════════════════
// Importzo — Page Skeleton
// Premium loading state used on initial page load and during navigation.
// Prevents broken layout flashes and makes the app feel intentional.
// ═══════════════════════════════════════════════════════════════════

const PRIMARY = "#17320A";
const FONT = "'ImportzoFont', sans-serif";

function Shimmer({ className = "", style = {} }) {
  return <div className={`animate-shimmer rounded-lg ${className}`} style={{ backgroundColor: "#f3f4f6", ...style }} />;
}

// Header shimmer used by all skeleton variants — keeps the logo lockup
// so the page never feels empty.
function SkeletonHeader({ label }) {
  return (
    <div className="flex items-center gap-2.5">
      <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain", opacity: 0.85 }} />
      {label && (
        <span style={{ fontSize: 18, fontWeight: 600, color: PRIMARY, fontFamily: FONT }}>{label}</span>
      )}
    </div>
  );
}

function CardShimmer({ height = 96 }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
      <div className="flex items-start gap-4">
        <Shimmer className="w-11 h-11 rounded-xl flex-shrink-0" />
        <div className="flex-1 space-y-2">
          <Shimmer className="h-4 w-1/3" />
          <Shimmer className="h-3 w-2/3" />
          {height > 90 && <Shimmer className="h-3 w-1/2" />}
        </div>
      </div>
    </div>
  );
}

function TableRowShimmer() {
  return (
    <div className="flex items-center gap-4 px-5 py-3.5 border-t border-gray-100">
      <Shimmer className="h-3 w-24 flex-shrink-0" />
      <Shimmer className="h-5 w-20 flex-shrink-0 rounded-full" />
      <Shimmer className="h-3 flex-1 min-w-[80px]" />
      <Shimmer className="h-3 w-16 flex-shrink-0" />
      <Shimmer className="h-5 w-20 flex-shrink-0 rounded-full" />
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-6 animate-fade-in">
      <SkeletonHeader label="Dashboard" />
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => <CardShimmer key={i} />)}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
            <div className="flex items-center gap-3">
              <Shimmer className="w-9 h-9 rounded-lg flex-shrink-0" />
              <div className="flex-1 space-y-1.5">
                <Shimmer className="h-4 w-12" />
                <Shimmer className="h-2 w-16" />
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <Shimmer className="h-4 w-32" />
        </div>
        {[0, 1, 2, 3].map((i) => <TableRowShimmer key={i} />)}
      </div>
    </div>
  );
}

export function HubSkeleton({ label = "Loading" }) {
  return (
    <div className="space-y-6 animate-fade-in">
      <SkeletonHeader label={label} />
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm">
        <div className="flex items-start gap-4">
          <Shimmer className="w-12 h-12 rounded-xl flex-shrink-0" />
          <div className="flex-1 space-y-2">
            <Shimmer className="h-5 w-1/3" />
            <Shimmer className="h-3 w-2/3" />
            <Shimmer className="h-3 w-1/2" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => <CardShimmer key={i} />)}
      </div>
    </div>
  );
}

export function TableSkeleton({ label = "Loading", rows = 5 }) {
  return (
    <div className="space-y-6 animate-fade-in">
      <SkeletonHeader label={label} />
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <Shimmer className="h-4 w-32" />
        </div>
        {Array.from({ length: rows }).map((_, i) => <TableRowShimmer key={i} />)}
      </div>
    </div>
  );
}

export function FormSkeleton({ label = "Loading" }) {
  return (
    <div className="space-y-6 animate-fade-in">
      <SkeletonHeader label={label} />
      <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm max-w-xl mx-auto space-y-4">
        <Shimmer className="h-5 w-1/3" />
        <Shimmer className="h-3 w-2/3" />
        <Shimmer className="h-10 w-full" />
        <Shimmer className="h-10 w-full" />
        <Shimmer className="h-10 w-32" />
      </div>
    </div>
  );
}
