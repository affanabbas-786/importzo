// ═══════════════════════════════════════════════════════════════════
// Phase 10 — who still has their 7-day free trial, and who has spent it.
//
// The trial is NOT configured here. It lives on each plan in the `billing`
// config (shopify.server.js), which is where @shopify/shopify-api reads it
// from when it builds appSubscriptionCreate. This module answers a different
// question: whether that configured trial should be SUPPRESSED for this shop
// on this particular subscribe.
//
// WHY IT HAS TO BE SUPPRESSED SOMETIMES
// Shopify does not remember that a shop has already had a trial. trialDays is
// simply a property of each subscription you create, so every subscribe with
// trialDays: 7 grants a fresh 7 free days — including one created seconds
// after cancelling. Without this check, the in-app cancel added in Phase 10
// doubles as an unlimited-free-usage loop:
//     upgrade (7 free days) -> cancel -> upgrade (7 more) -> ...
// The same applies to an ordinary tier or interval switch (Pro monthly ->
// Pro yearly), which is also a brand-new subscription as far as Shopify is
// concerned — and under the old App Pricing setup was not something this app
// could even initiate.
//
// THE RULE: the trial belongs to the shop's first paid subscription ever, not
// to each subscription.
//
// Ported deliberately from the same guard in the Citeable app, which has been
// running this rule in production; the reasoning below is unchanged because
// the Shopify behaviour it compensates for is unchanged.
// ═══════════════════════════════════════════════════════════════════

// Statuses meaning "the merchant actually approved this at some point" — they
// got real paid access, so any trial attached to it was theirs to use.
//
// PENDING and DECLINED are deliberately excluded. Those are subscriptions this
// app created but the merchant never approved, and someone who opened the
// approval screen and backed out has consumed nothing. Counting them would
// mean one abandoned click silently burns the trial the App Store listing
// promises — a worse failure than the abuse this prevents, and far likelier.
const APPROVED_STATUSES = new Set(["ACTIVE", "CANCELLED", "EXPIRED", "FROZEN"]);

// `first: 25` rather than 1: we have to look past any PENDING/DECLINED rows to
// find whether an approved one exists, and a shop with more than 25 lifetime
// subscriptions has unambiguously had a trial already.
const SUBSCRIPTION_HISTORY_QUERY = `#graphql
  query ImportzoTrialEligibility {
    currentAppInstallation {
      allSubscriptions(first: 25, reverse: true) {
        nodes {
          id
          name
          status
          trialDays
          createdAt
        }
      }
    }
  }`;

/**
 * The decision itself, split from the fetch so the rule is testable with no
 * Shopify client. `nodes` are AppSubscription records as the query returns
 * them.
 *
 * Returns `override: 0` to suppress, or `undefined` to leave the plan's own
 * trialDays in place — see trialDaysOverrideFor for why those two exact
 * values.
 */
export function decideTrialOverride(nodes) {
  const priorApproved = (nodes || []).filter((n) => APPROVED_STATUSES.has(n?.status));
  return { override: priorApproved.length > 0 ? 0 : undefined, priorApproved };
}

/**
 * The single trial decision for a shop, shared by the Billing page (deciding
 * what trial terms to SHOW) and the charge action (deciding what to REQUEST),
 * so the two can never disagree — a page promising "$0 today, 7-day trial"
 * next to a charge that grants no trial is exactly the kind of mismatch the
 * App Store review flagged.
 *
 * Returns the value to pass as billing.request's `trialDays` override:
 *   undefined -> grant the plan's configured trial (7 days)
 *   0         -> suppress it
 *
 * On a TEST charge the trial is always granted: no money moves, so the
 * cancel-and-resubscribe abuse trialDaysOverrideFor guards against is not
 * possible, and a reviewer testing repeatedly on a development store must see
 * the advertised trial every time.
 */
export async function resolveTrialDays({ shopifyGraphql, shop, token, version, isTest }) {
  if (isTest) return undefined;
  return trialDaysOverrideFor({ shopifyGraphql, shop, token, version });
}

/** Whether `resolveTrialDays`'s result means "this shop gets a trial on its next subscribe". */
export function grantsTrial(trialDaysOverride) {
  return trialDaysOverride === undefined;
}

/**
 * The trialDays value to pass to billing.request():
 *   undefined -> send nothing, so the SDK uses the plan's own trialDays (7).
 *   0         -> explicitly override the plan; no trial on this subscription.
 *
 * The SDK spreads request-level overrides over the plan config and drops keys
 * whose value is undefined, so these two values are exactly the "use the
 * default" and "suppress it" cases.
 */
export async function trialDaysOverrideFor({ shopifyGraphql, shop, token, version }) {
  try {
    const data = await shopifyGraphql(shop, token, SUBSCRIPTION_HISTORY_QUERY, {}, version);
    const nodes = data?.currentAppInstallation?.allSubscriptions?.nodes || [];
    const { override, priorApproved } = decideTrialOverride(nodes);

    if (override === 0) {
      console.log(
        `[billing-trial] trial suppressed for ${shop} — ${priorApproved.length} prior approved subscription(s)`,
      );
      return 0;
    }

    console.log(`[billing-trial] trial granted for ${shop} — no prior approved subscription`);
    return undefined;
  } catch (err) {
    // Fail OPEN, and say so loudly.
    //
    // The two failure modes are not symmetric. Suppressing the trial because
    // OUR query failed takes away something the App Store listing and this
    // app's own Billing page promise a first-time merchant in writing —
    // visible to them, and a billing-terms misrepresentation. Granting an
    // extra trial costs at most 7 days of one plan, and the merchant cannot
    // force it: nothing they control makes this query fail.
    console.warn(
      `[billing-trial] could not read subscription history for ${shop} — granting the configured trial:`,
      err?.message,
    );
    return undefined;
  }
}
