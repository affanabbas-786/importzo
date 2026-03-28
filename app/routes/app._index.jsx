import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);

  const imports = await prisma.importJob.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return { imports };
};

export default function Dashboard() {
  const { imports } = useLoaderData();

  const totalImports = imports.length;
  const totalProducts = imports.reduce((sum, i) => sum + i.successCount, 0);
  const totalErrors = imports.reduce((sum, i) => sum + i.errorCount, 0);
  const successRate =
    totalProducts + totalErrors > 0
      ? Math.round((totalProducts / (totalProducts + totalErrors)) * 100)
      : 100;

  return (
    <s-page heading="Dashboard">
      <div className="space-y-6 animate-fade-in">
        {/* Branded Header */}
        <div className="flex items-center justify-between flex-wrap gap-4 animate-slide-up">
          <div className="flex items-center gap-3.5">
            <img
              src="/logo.png"
              alt="Importzo"
              style={{ height: 40, width: "auto", objectFit: "contain" }}
            />
            <div>
              <h1 className="text-xl font-bold text-gray-900 tracking-tight">
                <span style={{ background: "linear-gradient(135deg, #0D9488, #0891B2)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", textShadow: "0 1px 3px rgba(0,0,0,0.15)" }}>Importzo</span>
              </h1>
              <p className="text-sm text-gray-500">Turn messy CSVs into Shopify-ready products instantly</p>
            </div>
          </div>
          <a
            href="/app/import"
            className="inline-flex items-center gap-2 px-5 py-2.5 text-white text-sm rounded-xl shadow-md transition-all duration-200 active:scale-[0.97] hover:brightness-110 hover:shadow-[0_4px_12px_rgba(13,148,136,0.4)]"
            style={{ background: "linear-gradient(135deg, #0D9488, #0891B2)", fontWeight: 600, borderRadius: 8 }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
            </svg>
            New Import
          </a>
        </div>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-all duration-200 hover:-translate-y-0.5 animate-slide-up stagger-1">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-blue-50 flex items-center justify-center">
                <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{totalImports}</p>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Total Imports</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-all duration-200 hover:-translate-y-0.5 animate-slide-up stagger-2">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-green-50 flex items-center justify-center">
                <svg className="w-5 h-5 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                </svg>
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{totalProducts}</p>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Products Created</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm hover:shadow-md transition-all duration-200 hover:-translate-y-0.5 animate-slide-up stagger-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-lg bg-emerald-50 flex items-center justify-center">
                <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <p className="text-2xl font-bold text-gray-900">{successRate}%</p>
                <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Success Rate</p>
              </div>
            </div>
          </div>
        </div>

        {/* Import History */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden animate-slide-up stagger-4">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-base font-semibold text-gray-900">Import History</h2>
          </div>

          {imports.length === 0 ? (
            <div className="p-12 text-center">
              <div className="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-gray-300" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4" />
                </svg>
              </div>
              <p className="text-sm text-gray-500 mb-4">No imports yet. Start by importing your first CSV file.</p>
              <a
                href="/app/import"
                className="inline-flex items-center gap-2 px-4 py-2 text-white text-sm rounded-lg transition-all hover:brightness-110 hover:shadow-[0_4px_12px_rgba(13,148,136,0.4)]"
                style={{ background: "linear-gradient(135deg, #0D9488, #0891B2)", fontWeight: 600, borderRadius: 8 }}
              >
                Import Products
              </a>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50/80">
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Date</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">File</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Products</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Result</th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {imports.map((job) => (
                    <tr key={job.id} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-6 py-3.5 text-sm text-gray-600 whitespace-nowrap">
                        {new Date(job.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </td>
                      <td className="px-6 py-3.5">
                        <span className="text-sm font-medium text-gray-900">{job.fileName}</span>
                      </td>
                      <td className="px-6 py-3.5">
                        <span className="text-sm text-gray-600">
                          {job.successCount}
                          <span className="text-gray-400"> / {job.totalRows}</span>
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
                        {job.status === "completed" && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-green-50 text-green-700">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>
                            Completed
                          </span>
                        )}
                        {job.status === "completed_with_errors" && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-50 text-amber-700">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500"></span>
                            Partial
                          </span>
                        )}
                        {job.status === "failed" && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-red-50 text-red-700">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-500"></span>
                            Failed
                          </span>
                        )}
                        {job.status === "pending" && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-50 text-gray-600">
                            <span className="w-1.5 h-1.5 rounded-full bg-gray-400"></span>
                            Pending
                          </span>
                        )}
                        {job.status === "importing" && (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-50 text-blue-700">
                            <span className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse"></span>
                            Importing
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
