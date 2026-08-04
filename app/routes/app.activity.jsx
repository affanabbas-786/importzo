import { useLoaderData, useRouteError, Link } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { BRAND, JOB_TYPE_CONFIG, JOB_STATUS_MAP } from "../lib/constants";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";
import { LeafIcon } from "../components/decor";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  let imports = [];
  try {
    imports = await prisma.importJob.findMany({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  } catch (err) {
    console.warn("[importzo] activity loader failed:", err?.message || err);
  }
  return { imports };
};

const { primary, font } = BRAND;

export default function ActivityPage() {
  const { imports } = useLoaderData();

  return (
    <s-page
      heading="Activity"
      subtitle="Import history"
      backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}
    >
      <div className="space-y-6 animate-fade-in">
        <div className="flex items-center gap-2.5">
          <img src="/logo.png" alt="Importzo" style={{ height: 40, width: "auto", objectFit: "contain" }} />
          <span style={{ fontSize: 18, fontWeight: 600, color: primary, fontFamily: font }} className="flex items-center gap-1.5">
            Activity <LeafIcon size={14} />
          </span>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          {imports.length === 0 ? (
            <div className="p-12 text-center">
              <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                </svg>
              </div>
              <p className="text-sm text-gray-500 mb-4">No import history yet.</p>
              <Link
                to="/app/import"
                className="inline-flex items-center gap-2 px-4 py-2 text-white text-sm rounded-lg transition-all hover:brightness-110"
                style={{ background: primary, fontWeight: 600, fontFamily: font }}
              >
                Start Importing
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50/80">
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Type</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">File</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Records</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Result</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {imports.map((job) => {
                    const tc = JOB_TYPE_CONFIG[job.importType] || JOB_TYPE_CONFIG.products;
                    return (
                      <tr key={job.id} className="hover:bg-gray-50/50 transition-colors">
                        <td className="px-6 py-3.5 text-sm text-gray-600 whitespace-nowrap">
                          {new Date(job.createdAt).toLocaleDateString("en-US", {
                            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
                          })}
                        </td>
                        <td className="px-6 py-3.5">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${tc.bg} ${tc.text}`}>
                            {tc.label}
                          </span>
                        </td>
                        <td className="px-6 py-3.5">
                          <span className="text-sm font-medium text-gray-900">{job.fileName}</span>
                        </td>
                        <td className="px-6 py-3.5">
                          <span className="text-sm text-gray-600">
                            {job.successCount}<span className="text-gray-400"> / {job.totalRows}</span>
                          </span>
                        </td>
                        <td className="px-6 py-3.5">
                          <div className="flex items-center gap-2">
                            {job.successCount > 0 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-50 text-green-700">
                                {job.successCount} ok
                              </span>
                            )}
                            {job.errorCount > 0 && (
                              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-50 text-red-700">
                                {job.errorCount} err
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-3.5">
                          {(() => {
                            const s = JOB_STATUS_MAP[job.status] || JOB_STATUS_MAP.pending;
                            return (
                              <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${s.bg} ${s.text}`}>
                                <span className={`w-1.5 h-1.5 rounded-full ${s.dot}`} />{s.label}
                              </span>
                            );
                          })()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <FriendlyErrorBoundary
      heading="Activity"
      title="We couldn't load your activity history"
      message="Please try again. Your past imports are safely stored — we just couldn't display them right now."
      error={error}
    />
  );
}
export const headers = (headersArgs) => boundary.headers(headersArgs);
