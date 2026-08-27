// ═══════════════════════════════════════════════════════════════════
// The first thing a merchant sees, and what replaces it once they're going.
//
// Two Built for Shopify criteria land on the same piece of the dashboard:
// 4.2.2 wants a concise onboarding that helps a merchant establish the app's
// core functionality, and 4.2.3 wants the homepage to say whether the app is
// set up and working. Those are the same question asked at two different
// points in a shop's life, so this is one component with two states rather
// than a checklist that sits there forever.
//
// It is deliberately NOT a progress checklist. Importzo has two genuinely
// different jobs — move a whole store, or import a CSV — and plenty of
// merchants only ever want one of them. A linear "3 steps to get started"
// would mark half its users permanently incomplete for declining to use a
// feature they never wanted.
//
// It is also not an upsell. Nothing plan-gated appears here: a merchant
// finding their feet is the worst possible moment to sell at them, and BFS
// 4.3.3/4.3.6 are explicit about not distracting merchants with promotional
// content they can't dismiss.
// ═══════════════════════════════════════════════════════════════════

import PropTypes from "prop-types";
import { Link } from "react-router";
import { BRAND } from "../lib/constants";

const P = BRAND.primary, S = BRAND.secondary, F = BRAND.font;

const fmt = (iso) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" }) : null;

function Dot({ ok }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block rounded-full flex-shrink-0"
      style={{ width: 7, height: 7, background: ok ? S : "#C9CDC2" }}
    />
  );
}
Dot.propTypes = { ok: PropTypes.bool };

/** Established shop: one line that answers "is this working?". */
function StatusStrip({ sourceShop, transfers, csvImports, lastRunAt }) {
  const ran = fmt(lastRunAt);
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm px-5 py-3.5">
      <div className="flex items-center gap-x-6 gap-y-2 flex-wrap text-sm">
        <span className="flex items-center gap-2">
          <Dot ok={!!sourceShop} />
          {sourceShop ? (
            <>Source store <span className="font-medium text-gray-900">{sourceShop}</span></>
          ) : (
            <Link to="/app/transfer" className="font-medium hover:underline" style={{ color: S }}>
              Connect a source store
            </Link>
          )}
        </span>

        <span className="flex items-center gap-2 text-gray-600">
          <Dot ok={transfers > 0 || csvImports > 0} />
          {transfers > 0 && `${transfers} transfer${transfers === 1 ? "" : "s"}`}
          {transfers > 0 && csvImports > 0 && " · "}
          {csvImports > 0 && `${csvImports} CSV import${csvImports === 1 ? "" : "s"}`}
        </span>

        {ran && <span className="text-gray-500 text-xs">Last run {ran}</span>}
      </div>
    </div>
  );
}
StatusStrip.propTypes = {
  sourceShop: PropTypes.string, transfers: PropTypes.number,
  csvImports: PropTypes.number, lastRunAt: PropTypes.string,
};

/** First run: what this app is for, and the two ways in. */
function FirstRun({ sourceShop }) {
  return (
    <div className="rounded-2xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      <div className="px-6 pt-6 pb-5">
        <p className="text-xs font-semibold tracking-wider uppercase" style={{ color: S }}>
          Getting started
        </p>
        <h2 className="text-lg font-semibold text-gray-900 mt-1.5" style={{ fontFamily: F }}>
          Two ways to fill this store
        </h2>
        <p className="text-sm text-gray-600 mt-1 max-w-2xl">
          Importzo moves a catalog into the store you&apos;re in now. Pick whichever
          matches where your products are today — you can do both, and neither
          writes anything until you say so.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-px" style={{ background: "#EFEFEA" }}>
        {/* Primary path first and visually dominant — BFS 4.2.5. */}
        <div className="bg-white px-6 py-5 flex flex-col">
          <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>
            From another Shopify store
          </p>
          <p className="text-xs text-gray-600 mt-1 flex-1">
            Products, collections, pages, blogs, navigation and themes. Connect the
            store you&apos;re moving from, preview what would change with a dry run,
            then transfer.
          </p>
          <Link
            to="/app/transfer"
            className="mt-4 inline-flex items-center justify-center px-5 py-2.5 text-sm rounded-lg text-white font-semibold transition-all hover:brightness-110"
            style={{ background: P, fontFamily: F }}
          >
            {sourceShop ? "Go to Transfer Store" : "Connect a source store"}
          </Link>
          {sourceShop && (
            <p className="text-xs text-gray-500 mt-2">
              Connected: <span className="font-medium text-gray-700">{sourceShop}</span>
            </p>
          )}
        </div>

        <div className="bg-white px-6 py-5 flex flex-col">
          <p className="text-sm font-semibold text-gray-900" style={{ fontFamily: F }}>
            From a CSV file
          </p>
          <p className="text-xs text-gray-600 mt-1 flex-1">
            Upload a file, map its columns once, and save that mapping as a
            template so the next file goes straight through.
          </p>
          <Link
            to="/app/import"
            className="mt-4 inline-flex items-center justify-center px-5 py-2.5 text-sm rounded-lg font-semibold border transition-all hover:bg-gray-50"
            style={{ borderColor: "rgba(46,99,22,0.28)", color: S, fontFamily: F }}
          >
            Import a CSV
          </Link>
        </div>
      </div>
    </div>
  );
}
FirstRun.propTypes = { sourceShop: PropTypes.string };

export function SetupGuide({ setup }) {
  if (!setup) return null;
  const started = setup.transfers > 0 || setup.csvImports > 0;
  return started ? <StatusStrip {...setup} /> : <FirstRun sourceShop={setup.sourceShop} />;
}

SetupGuide.propTypes = {
  setup: PropTypes.shape({
    sourceShop: PropTypes.string,
    transfers: PropTypes.number,
    csvImports: PropTypes.number,
    lastRunAt: PropTypes.string,
  }),
};
