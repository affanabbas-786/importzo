// Renders the REAL components — not mocks — to static HTML, so every
// decorated surface can be LOOKED AT without an authenticated Shopify frame.
//
// This exists because two visual bugs shipped without anyone seeing them: a
// corner "accent" whose brightest point landed 95px inside the card, on top
// of the body text, and an empty-state arrow drawn straight through both of
// the cards it was supposed to connect. Both were obvious in a screenshot and
// invisible in a diff.
//
// Add a <Sec> here whenever a component gains a state worth eyeballing.
import PropTypes from "prop-types";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { PlanBadge } from "../../app/components/PlanBadge.jsx";
import { UsageMeter } from "../../app/components/UsageMeter.jsx";
import { DecorativeBanner, DecorativeCorner, EmptyStateIllustration } from "../../app/components/decor.jsx";
import { BRAND } from "../../app/lib/constants.js";
import { COLORS } from "../../app/lib/design-tokens.js";

const P = BRAND.primary, S = BRAND.secondary, font = BRAND.font;

const u = (o) => ({ label: "Free", used: 70, limit: 250, remaining: 180, isUnlimited: false, ...o });
const PRO = { label: "Pro", used: 4210, limit: null, remaining: null, isUnlimited: true, interval: "monthly" };

function Sec({ title, children }) {
  return (
    <section style={{ marginBottom: 40 }}>
      <div style={{ font: "600 11px/1 ui-monospace,monospace", letterSpacing: ".12em", textTransform: "uppercase", color: "#6B7263", marginBottom: 12 }}>{title}</div>
      {children}
    </section>
  );
}

Sec.propTypes = { title: PropTypes.string, children: PropTypes.node };

const Page = () => (
  <MemoryRouter>
    <div style={{ maxWidth: 900, margin: "0 auto", padding: 28, background: "#fff" }}>

      <Sec title="Plan badge · layout header, right-aligned (real component)">
        <div className="flex justify-end px-4 pt-3 -mb-1" style={{ border: "1px dashed #D9DCD2", borderRadius: 10 }}>
          <PlanBadge usage={PRO} />
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 14 }}>
          <PlanBadge usage={u({ remaining: 180 })} />
          <PlanBadge usage={u({ used: 241, remaining: 9 })} />
          <PlanBadge usage={u({ used: 250, remaining: 0 })} />
        </div>
      </Sec>

      <Sec title="Usage meter · Transfer page (real component)">
        <div style={{ display: "grid", gap: 14 }}>
          <UsageMeter usage={PRO} showUpgrade />
          <UsageMeter usage={u({})} showUpgrade />
          <UsageMeter usage={u({ used: 241, remaining: 9 })} showUpgrade />
          <UsageMeter usage={u({ used: 250, remaining: 0 })} showUpgrade />
        </div>
      </Sec>

      <Sec title="Dashboard · welcome banner (DecorativeBanner, top-right)">
        <DecorativeBanner className="p-5 sm:p-6">
          <p className="text-sm text-gray-600 mb-4 max-w-xl">
            Welcome back — start an import, export your catalog, or move data between stores.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {["Import", "Export", "Transfer"].map((t) => (
              <div key={t} className="group bg-white rounded-2xl border border-gray-200 p-5 shadow-sm flex items-start gap-4">
                <div className="w-10 h-10 rounded-lg flex-shrink-0" style={{ background: COLORS.washLight }} />
                <div>
                  <p className="text-sm font-semibold text-gray-900">{t}</p>
                  <p className="text-xs text-gray-500 mt-0.5">One line of description.</p>
                </div>
              </div>
            ))}
          </div>
        </DecorativeBanner>
      </Sec>

      <Sec title="Dashboard · Quick Tips (DecorativeBanner, bottom-right)">
        <DecorativeBanner cornerPosition="bottom-right" className="p-5 sm:p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-3" style={{ fontFamily: font }}>Quick Tips</h2>
          <ul className="space-y-2.5">
            {[
              "Use Dry Run mode before a real transfer to preview exactly what would change, with nothing written yet.",
              "Scheduled Sync is available on the Pro and Agency plans — from $15/month, or $144/year to save 20%. See Billing to upgrade.",
              "Save a CSV column mapping as a template from any importer so you don't have to remap it next time.",
            ].map((tip) => (
              <li key={tip} className="flex items-start gap-2.5 text-sm text-gray-700">
                <span aria-hidden="true" className="mt-1.5 flex-shrink-0 rounded-full" style={{ width: 5, height: 5, background: COLORS.washDeep }} />
                <span>{tip}</span>
              </li>
            ))}
          </ul>
        </DecorativeBanner>
      </Sec>

      <Sec title="Settings · page header (standalone DecorativeCorner, opacity-60)">
        <div className="relative overflow-hidden rounded-2xl -m-2 p-2">
          <DecorativeCorner position="top-right" className="opacity-60" />
          <div className="relative flex items-center gap-2.5">
            <div style={{ height: 40, width: 40, borderRadius: 8, background: P }} />
            <span style={{ fontSize: 18, fontWeight: 600, color: P, fontFamily: font }}>Settings</span>
            <span className="ml-auto text-xs font-medium px-2 py-1 rounded-full" style={{ background: "rgba(46,99,22,0.1)", color: S }}>Saved</span>
          </div>
        </div>
      </Sec>

      <Sec title="Settings · contact card (DecorativeBanner, bottom-right)">
        <DecorativeBanner cornerPosition="bottom-right" className="p-5">
          <div className="flex items-center gap-4 flex-wrap">
            <div className="w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-white" style={{ color: P }}>?</div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-semibold text-gray-900">Direct contact</p>
              <p className="text-xs text-gray-500 mt-0.5">Email us anytime at <span className="font-semibold" style={{ color: S }}>support@importzo.app</span></p>
            </div>
          </div>
        </DecorativeBanner>
      </Sec>

      <Sec title="Dashboard · empty state (EmptyStateIllustration)">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-100">
            <h2 className="text-base font-semibold text-gray-900" style={{ fontFamily: font }}>Recent Activity</h2>
          </div>
          <div className="p-12 text-center">
            <EmptyStateIllustration size={88} className="mx-auto mb-4" />
            <p className="text-sm font-medium text-gray-700 mb-1">No activity yet</p>
            <p className="text-xs text-gray-400 mb-5">Import your first CSV file to get started.</p>
            <span className="inline-flex items-center gap-2 px-5 py-2.5 text-white text-sm rounded-lg" style={{ background: P, fontWeight: 600, fontFamily: font }}>Start Importing</span>
          </div>
        </div>
      </Sec>

    </div>
  </MemoryRouter>
);

process.stdout.write(renderToStaticMarkup(<Page />));
