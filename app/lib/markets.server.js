// ═══════════════════════════════════════════════════════════════════
// Phase 4 — Shopify Markets-aware transfer.
//
// Lets a merchant scope a product transfer to a single source-store
// Market (region) and tags the resulting destination products with that
// market's handle, matching what competing clone/migration apps already
// advertise (PRD Phase 4 item 2).
//
// Requires the `read_markets` scope — NOT currently declared in
// shopify.app.toml. Adding it is a merchant-visible change (existing
// installs get prompted to re-authorize the updated scope set, same as
// the Phase 3.2 scope removal), so this is held for explicit review
// rather than assumed. See PROGRESS.md.
//
// Market -> product filtering goes through Catalogs, not a direct field
// on Product: "When a publication isn't associated with the [market's]
// catalog, product availability is determined by the sales channel"
// (verified against shopify.dev's MarketCatalog reference) — i.e. most
// shops that haven't set up per-market catalogs have NO market-specific
// product restriction at all, and filtering would be meaningless (every
// product is "in" every market). listMarkets surfaces that distinction
// via `publicationIds` being empty rather than silently pretending a
// filter applies.
// ═══════════════════════════════════════════════════════════════════

const MARKETS_QUERY = `#graphql
  query ListMarkets($first: Int!) {
    markets(first: $first) {
      nodes {
        id
        name
        handle
        status
        type
        currencySettings { baseCurrency { currencyCode } }
        catalogs(first: 10) {
          nodes { id publication { id } }
        }
      }
    }
  }`;

/**
 * Lists the shop's configured Markets, each annotated with whether it has
 * a restricting catalog (and therefore a meaningful product filter) and
 * that catalog's publication id(s) for use in a `publication_ids:` query
 * filter against the `products`/`productsCount` connections.
 *
 * Never throws on the request itself failing due to a missing scope —
 * callers (the transfer UI, job creation) need to degrade to "market
 * filtering unavailable" rather than breaking the whole flow, since an
 * existing merchant's token may predate the read_markets scope being
 * added until they re-authorize.
 */
export async function listMarkets({ shopifyGraphql, shop, token, version }) {
  try {
    const data = await shopifyGraphql(shop, token, MARKETS_QUERY, { first: 100 }, version);
    const nodes = data?.markets?.nodes || [];
    return {
      ok: true,
      markets: nodes.map((m) => {
        const publicationIds = (m.catalogs?.nodes || [])
          .map((c) => c.publication?.id)
          .filter(Boolean);
        return {
          id: m.id,
          name: m.name,
          handle: m.handle,
          status: m.status,
          type: m.type,
          currencyCode: m.currencySettings?.baseCurrency?.currencyCode || null,
          publicationIds,
          hasProductFilter: publicationIds.length > 0,
        };
      }),
    };
  } catch (err) {
    return { ok: false, error: err.message, markets: [] };
  }
}

/** Finds one market by id from a previously-fetched list (or a fresh fetch). */
export function findMarket(markets, marketId) {
  return markets.find((m) => m.id === marketId) || null;
}

/** Builds the `publication_ids:...` query filter, or null when the market has no restricting catalog. */
export function marketQueryFilter(market) {
  if (!market || !market.publicationIds?.length) return null;
  return `publication_ids:${market.publicationIds.map((id) => id.split("/").pop()).join(",")}`;
}
