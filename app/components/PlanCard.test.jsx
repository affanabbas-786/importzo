import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanCard } from "./PlanCard.jsx";
import { PLAN_IDS, PLANS } from "../lib/plans.js";
import { BRAND } from "../lib/constants";

// No jsdom in this project, and none is needed: PlanCard is presentational and
// takes every decision as a prop, so static markup is the whole of its
// observable behaviour. renderToStaticMarkup runs in plain node.
const { secondary: S } = BRAND;
const UNEMPHASISED_BORDER = "#e5e7eb";

const ELIGIBLE = { eligible: true, storeCount: 3, minStores: 3 };
const INELIGIBLE = { eligible: false, storeCount: 1, minStores: 3 };

function render(overrides = {}) {
  return renderToStaticMarkup(
    <PlanCard
      plan={PLANS[PLAN_IDS.AGENCY]}
      currentTier={PLAN_IDS.FREE}
      eligibility={ELIGIBLE}
      onSelect={() => {}}
      busy={false}
      planSelectionUrl="https://admin.shopify.com/store/x/charges/importzo/pricing_plans"
      {...overrides}
    />,
  );
}

/** The card's own root element, so assertions can't match nested markup. */
function rootTag(html) {
  return html.slice(0, html.indexOf(">") + 1);
}

describe("PlanCard featured chrome", () => {
  describe("featured={true}", () => {
    const html = render({ featured: true });
    const root = rootTag(html);

    it("renders the Most Popular badge", () => {
      expect(html).toContain("Most Popular");
    });

    it("marks itself featured for the DOM", () => {
      expect(root).toContain('data-featured="true"');
      expect(root).toContain(`data-plan-id="${PLAN_IDS.AGENCY}"`);
    });

    it("draws the 2px brand-green border", () => {
      expect(root).toContain(`border-color:${S}`);
      expect(root).toContain("border-width:2px");
    });

    it("carries the green elevation shadow", () => {
      expect(root).toMatch(/box-shadow:[^"]*rgba\(46,99,22/);
    });

    it("applies the lift and the roomier padding", () => {
      // sm:-mt-6 is what makes the card taller as well as higher, since grid
      // items stretch to the row height.
      expect(root).toContain("sm:-mt-6");
      expect(root).toContain("p-6");
      expect(root).not.toContain("p-5");
      // Above its neighbours, so the shadow isn't clipped by the next card.
      expect(root).toContain("relative");
      expect(root).toContain("z-10");
    });
  });

  describe("featured={false}", () => {
    const html = render({ featured: false });
    const root = rootTag(html);

    it("renders no badge", () => {
      expect(html).not.toContain("Most Popular");
    });

    it("marks itself unfeatured for the DOM", () => {
      expect(root).toContain('data-featured="false"');
    });

    it("keeps the plain 1px grey border", () => {
      expect(root).toContain(`border-color:${UNEMPHASISED_BORDER}`);
      expect(root).toContain("border-width:1px");
      expect(root).not.toContain(`border-color:${S}`);
    });

    it("carries no elevation shadow", () => {
      expect(root).not.toContain("box-shadow");
    });

    it("applies neither the lift nor the roomier padding", () => {
      expect(root).not.toContain("sm:-mt-6");
      expect(root).not.toContain("z-10");
      expect(root).toContain("p-5");
    });
  });

  it("defaults to unfeatured when the prop is omitted entirely", () => {
    const root = rootTag(render());
    expect(root).toContain('data-featured="false"');
    expect(root).not.toContain("sm:-mt-6");
  });
});

describe("PlanCard featured vs current plan", () => {
  // Both reasons produce a green edge, but only `featured` adds the badge and
  // the lift — otherwise every merchant's current plan would look recommended.
  it("gives the current plan a green border but no badge, lift or shadow", () => {
    const html = render({ featured: false, currentTier: PLAN_IDS.AGENCY });
    const root = rootTag(html);

    expect(root).toContain(`border-color:${S}`);
    expect(root).toContain("border-width:2px");
    expect(html).toContain("Current plan");
    expect(html).not.toContain("Most Popular");
    expect(root).not.toContain("box-shadow");
    expect(root).not.toContain("sm:-mt-6");
  });

  it("shows both markers when the featured plan is also the current one", () => {
    const html = render({ featured: true, currentTier: PLAN_IDS.AGENCY });

    expect(html).toContain("Most Popular");
    expect(html).toContain("Current plan");
    // The 2px green edge is applied once, not doubled.
    expect(rootTag(html).match(/border-width:/g)).toHaveLength(1);
  });
});

describe("PlanCard eligibility notice is independent of the chrome", () => {
  // The whole reason featuring became conditional: chrome follows eligibility,
  // but the warning inside the card follows plan.requiresEligibility, so an
  // ineligible merchant still gets told why Agency is out of reach.
  it("still warns an ineligible merchant on an unfeatured Agency card", () => {
    const html = render({ featured: false, eligibility: INELIGIBLE });

    expect(html).toMatch(/Unlocks at 3\+ stores/);
    expect(html).toContain("currently has 1");
    expect(html).not.toContain("Most Popular");
  });

  it("omits the warning for an eligible merchant", () => {
    const html = render({ featured: true, eligibility: ELIGIBLE });
    expect(html).not.toMatch(/Unlocks at 3\+ stores/);
  });

  it("never shows the warning on Pro, which has no store requirement", () => {
    const html = render({
      plan: PLANS[PLAN_IDS.PRO],
      featured: true,
      eligibility: INELIGIBLE,
    });
    expect(html).not.toMatch(/Unlocks at 3\+ stores/);
    expect(html).toContain("Most Popular");
  });
});
