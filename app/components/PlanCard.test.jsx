import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PlanCard } from "./PlanCard.jsx";
import { PLAN_IDS, PLANS, BILLING_INTERVAL } from "../lib/plans.js";
import { BRAND } from "../lib/constants";

// No jsdom in this project, and none is needed: PlanCard is presentational and
// takes every decision as a prop, so static markup is the whole of its
// observable behaviour. renderToStaticMarkup runs in plain node.
const { secondary: S } = BRAND;
const UNEMPHASISED_BORDER = "#e5e7eb";

function render(overrides = {}) {
  return renderToStaticMarkup(
    <PlanCard
      plan={PLANS[PLAN_IDS.AGENCY]}
      currentTier={PLAN_IDS.FREE}
      period={BILLING_INTERVAL.MONTHLY}
      onSelect={() => {}}
      onCancel={() => {}}
      busy={false}
      {...overrides}
    />,
  );
}

/** The card's own root element, so assertions can't match nested markup. */
function rootTag(html) {
  return html.slice(0, html.indexOf(">") + 1);
}

// Phase 10 — the featured card's chrome (ring, lift, top bar, glint) moved
// out of inline styles and into the .iz-plan-cell--featured class, matching
// the Citeable Plans design this page now reproduces. So the assertions are
// on the class the card claims rather than on the shadow it paints: the
// visual is in tailwind.css, and duplicating its pixel values here would
// only test that two files were edited together.
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

    it("claims the featured cell class that carries the ring, lift and glint", () => {
      expect(root).toContain("iz-plan-cell--featured");
    });

    // The ring is a box-shadow on the cell; a coloured border on the inner
    // card as well would stack into a visibly thicker, mismatched edge.
    it("does not also paint an inline green border", () => {
      expect(html).not.toContain(`border-color:${S}`);
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

    it("does not claim the featured cell class", () => {
      expect(root).not.toContain("iz-plan-cell--featured");
    });

    it("keeps the plain grey border on a plan the shop is not on", () => {
      expect(html).toContain(`border-color:${UNEMPHASISED_BORDER}`);
    });
  });

  it("defaults to unfeatured when the prop is omitted entirely", () => {
    const root = rootTag(render());
    expect(root).toContain('data-featured="false"');
    expect(root).not.toContain("iz-plan-cell--featured");
  });
});

describe("PlanCard featured vs current plan", () => {
  it("gives the current plan a green border but no badge or featured class", () => {
    const html = render({ featured: false, currentTier: PLAN_IDS.AGENCY });
    const root = rootTag(html);

    expect(html).toContain(`border-color:${S}`);
    expect(html).toContain("Current plan");
    expect(html).not.toContain("Most Popular");
    expect(root).not.toContain("iz-plan-cell--featured");
  });

  // Changed deliberately in Phase 10, matching Citeable: "Most Popular" is a
  // recommendation to buy, so putting it on the card the merchant already
  // pays for is recommending a purchase they have already made. The "Current
  // plan" pill is what that card gets instead.
  it("drops Most Popular when the featured plan is the one they already hold", () => {
    const html = render({ featured: true, currentTier: PLAN_IDS.AGENCY });

    expect(html).toContain("Current plan");
    expect(html).not.toContain("Most Popular");
  });
});

// The bug this replaced: a shop on Pro was offered "Upgrade to Pro", because
// the card compared interval and Shopify had reported none.
describe("PlanCard call-to-action state", () => {
  it("disables the card for the exact plan and period the shop is on", () => {
    const html = render({
      plan: PLANS[PLAN_IDS.PRO], currentTier: PLAN_IDS.PRO,
      currentInterval: BILLING_INTERVAL.MONTHLY, period: BILLING_INTERVAL.MONTHLY,
    });

    expect(rootTag(html)).toContain('data-cta="current"');
    expect(html).toContain("Active plan");
    expect(html).toContain("disabled");
    expect(html).not.toMatch(/Upgrade to Pro/);
  });

  it("never offers an upgrade to the tier the shop already holds, even when the period is unknown", () => {
    const html = render({
      plan: PLANS[PLAN_IDS.PRO], currentTier: PLAN_IDS.PRO,
      currentInterval: null, period: BILLING_INTERVAL.MONTHLY,
    });

    expect(rootTag(html)).toContain('data-cta="current"');
    expect(html).not.toMatch(/Upgrade to Pro/);
  });

  it("offers a period switch on the same tier, which is a real billable change", () => {
    const html = render({
      plan: PLANS[PLAN_IDS.PRO], currentTier: PLAN_IDS.PRO,
      currentInterval: BILLING_INTERVAL.MONTHLY, period: BILLING_INTERVAL.YEARLY,
    });

    expect(rootTag(html)).toContain('data-cta="switch"');
    expect(html).toContain("Switch to yearly");
  });

  it("offers a real upgrade for a different tier", () => {
    const html = render({ plan: PLANS[PLAN_IDS.PRO], currentTier: PLAN_IDS.FREE });

    expect(rootTag(html)).toContain('data-cta="select"');
    expect(html).toContain("Upgrade to Pro");
  });

  it("offers the downgrade on the Free card only when the shop is paying", () => {
    const paying = render({ plan: PLANS[PLAN_IDS.FREE], currentTier: PLAN_IDS.PRO });
    expect(rootTag(paying)).toContain('data-cta="downgrade"');
    expect(paying).toContain("Downgrade to Free");

    const free = render({ plan: PLANS[PLAN_IDS.FREE], currentTier: PLAN_IDS.FREE });
    expect(rootTag(free)).toContain('data-cta="included"');
    expect(free).toContain("Included");
  });

  // One price per card. Two buttons meant reading four prices to compare
  // three plans, which is what the toggle above the grid replaced.
  it("shows exactly one call-to-action, priced by the toggle", () => {
    const monthly = render({ plan: PLANS[PLAN_IDS.PRO], period: BILLING_INTERVAL.MONTHLY });
    expect(monthly.match(/<button/g)).toHaveLength(1);
    expect(monthly).toContain("$15");
    expect(monthly).not.toContain("$144");

    const yearly = render({ plan: PLANS[PLAN_IDS.PRO], period: BILLING_INTERVAL.YEARLY });
    expect(yearly.match(/<button/g)).toHaveLength(1);
    expect(yearly).toContain("$144");
  });
});

// App Store review: the trial terms have to be the PRIMARY price framing on
// this page, not a subtitle. "$0 today" is what the reviewer's screencast
// showed as missing.
describe("PlanCard trial framing", () => {
  it("leads with $0 today and states the recurring price and trial length below, for a trial-eligible upgrade", () => {
    const html = render({ plan: PLANS[PLAN_IDS.PRO], currentTier: PLAN_IDS.FREE, trialEligible: true });

    expect(html).toContain("$0 today");
    expect(html).toMatch(/then \$15\/mo after your 7-day free trial/);
    expect(html).toContain("Start 7-day free trial");
    expect(html).toMatch(/No charge for 7 days\. Cancel anytime before the trial ends\./);
  });

  it("uses the yearly recurring amount in the sub-price when the toggle is yearly", () => {
    const html = render({
      plan: PLANS[PLAN_IDS.PRO], currentTier: PLAN_IDS.FREE,
      period: BILLING_INTERVAL.YEARLY, trialEligible: true,
    });
    expect(html).toContain("$0 today");
    expect(html).toMatch(/then \$144\/yr after your 7-day free trial/);
  });

  it("does NOT show $0-today framing for a period switch on the plan the merchant already holds", () => {
    const html = render({
      plan: PLANS[PLAN_IDS.PRO], currentTier: PLAN_IDS.PRO,
      currentInterval: BILLING_INTERVAL.MONTHLY, period: BILLING_INTERVAL.YEARLY,
      trialEligible: true,
    });
    expect(html).not.toContain("$0 today");
    expect(html).toContain("Switch to yearly");
    expect(html).not.toMatch(/No charge for 7 days/);
  });

  it("does NOT show $0-today framing when the shop is no longer trial-eligible", () => {
    const html = render({ plan: PLANS[PLAN_IDS.PRO], currentTier: PLAN_IDS.FREE, trialEligible: false });
    expect(html).not.toContain("$0 today");
    expect(html).toContain("Upgrade to Pro");
    // The plain trial pill still discloses the offer.
    expect(html).toContain("7-day free trial");
  });

  it("never applies trial framing to the Free card", () => {
    const html = render({ plan: PLANS[PLAN_IDS.FREE], currentTier: PLAN_IDS.PRO, trialEligible: true });
    expect(html).not.toContain("$0 today");
    expect(html).not.toMatch(/No charge for 7 days/);
  });
});

describe("PlanCard — no stale 3-store eligibility copy", () => {
  // The "Agency unlocks at 3+ stores" model was removed: any Pro/Agency payer
  // links companions directly, no gate. None of that copy may survive.
  it("never renders an 'Unlocks at 3+ stores' warning on any card", () => {
    for (const id of [PLAN_IDS.FREE, PLAN_IDS.PRO, PLAN_IDS.AGENCY]) {
      const html = render({ plan: PLANS[id] });
      expect(html).not.toMatch(/Unlocks at/i);
      expect(html).not.toMatch(/\d\+ stores/);
      expect(html).not.toMatch(/qualify/i);
      expect(html).not.toMatch(/per store/);
    }
  });

  it("lists the included companion slots on each paid card", () => {
    expect(render({ plan: PLANS[PLAN_IDS.PRO] })).toContain("1 companion store included");
    expect(render({ plan: PLANS[PLAN_IDS.AGENCY] })).toContain("5 companion stores included");
    expect(render({ plan: PLANS[PLAN_IDS.FREE] })).not.toMatch(/companion store/);
  });

  it("Agency card describes the flat companion coverage, not a store requirement", () => {
    const html = render({ plan: PLANS[PLAN_IDS.AGENCY] });
    expect(html).toContain("Flat price covers this store plus 5 companion stores.");
  });
});
