// ═══════════════════════════════════════════════════════════════════
// Shared helpers for creating a Shopify product with options + variants.
//
// On the pinned Admin API version (2025-10, per app/shopify.server.js
// ApiVersion.October25 — verified against shopify.dev's GraphQL reference,
// not assumed), ProductInput no longer has "options" or "variants" fields.
// productCreate only supports creating a product with a single initial
// variant. Multi-variant products now require two calls:
//
//   1. productCreate(product: ProductCreateInput!) — title/vendor/tags/etc,
//      plus productOptions (the option names and every value they can take).
//   2. productVariantsBulkCreate(productId, variants, strategy:
//      REMOVE_STANDALONE_VARIANT) — the actual priced/SKU'd variants,
//      replacing the single placeholder variant productCreate auto-creates.
//
// Schema verified directly against shopify.dev for: ProductCreateInput,
// ProductVariantsBulkInput, OptionCreateInput, VariantOptionValueInput,
// InventoryItemInput, InventoryItemMeasurementInput, InventoryLevelInput,
// WeightInput.
// ═══════════════════════════════════════════════════════════════════

// Builds ProductCreateInput.productOptions from normalized variant data.
// `optionNames` is an ordered list of option names (e.g. ["Size", "Color"]);
// each variant's `options` array holds the corresponding positional values,
// e.g. { options: ["Small", "Red"] }.
export function buildProductOptions(optionNames, variants) {
  if (!optionNames?.length) return undefined;
  return optionNames.map((name, i) => {
    const seen = new Set();
    const values = [];
    for (const v of variants || []) {
      const val = v.options?.[i];
      if (val && !seen.has(val)) {
        seen.add(val);
        values.push({ name: val });
      }
    }
    // OptionCreateInput.values is required — fall back to a single
    // placeholder if no variant actually supplied a value for this option.
    return { name, values: values.length ? values : [{ name: "Default" }] };
  });
}

// Builds the [ProductVariantsBulkInput!] array for productVariantsBulkCreate.
export function buildVariantsBulkInput(optionNames, variants) {
  return (variants || []).map((v) => {
    const bulk = {};
    if (optionNames?.length) {
      bulk.optionValues = optionNames.map((name, i) => ({ optionName: name, name: v.options?.[i] || "Default Title" }));
    }
    if (v.price !== undefined && v.price !== null && v.price !== "") bulk.price = v.price;
    if (v.compareAtPrice) bulk.compareAtPrice = v.compareAtPrice;
    if (v.taxable !== undefined) bulk.taxable = v.taxable;
    if (v.inventoryPolicy) bulk.inventoryPolicy = String(v.inventoryPolicy).toUpperCase();
    if (v.barcode) bulk.barcode = v.barcode;

    // sku/requiresShipping/weight all live under InventoryItemInput now,
    // not directly on ProductVariantsBulkInput.
    const inventoryItem = {};
    if (v.sku) inventoryItem.sku = v.sku;
    if (v.requiresShipping !== undefined) inventoryItem.requiresShipping = v.requiresShipping;
    const weightValue = v.weight !== undefined && v.weight !== null && v.weight !== ""
      ? (typeof v.weight === "string" ? parseFloat(v.weight) : v.weight)
      : undefined;
    if (weightValue !== undefined && !Number.isNaN(weightValue) && v.weightUnit) {
      inventoryItem.measurement = { weight: { value: weightValue, unit: String(v.weightUnit).toUpperCase() } };
    }
    if (Object.keys(inventoryItem).length) bulk.inventoryItem = inventoryItem;

    if (v.inventoryQuantity !== undefined && v.inventoryQuantity !== null && v.locationId) {
      bulk.inventoryQuantities = [{ availableQuantity: v.inventoryQuantity, locationId: v.locationId }];
    }
    return bulk;
  });
}

const PRODUCT_CREATE_MUTATION = `#graphql
  mutation ProductCreate($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id }
      userErrors { field message }
    }
  }`;

const PRODUCT_VARIANTS_BULK_CREATE_MUTATION = `#graphql
  mutation ProductVariantsBulkCreate($productId: ID!, $variants: [ProductVariantsBulkInput!]!, $strategy: ProductVariantsBulkCreateStrategy) {
    productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: $strategy) {
      productVariants { id }
      userErrors { field message }
    }
  }`;

// Orchestrates the two-mutation flow described above. `shopifyGraphql` is
// injected so callers reuse whatever retry-wrapped client they already have
// (see shopify-api.server.js) rather than this module owning a fetch client.
//
// `product` must be plain ProductCreateInput fields (title, descriptionHtml,
// vendor, productType, tags, handle, status, ...) — NOT including
// options/variants, which no longer belong there.
export async function createProductWithVariants({ shopifyGraphql, shop, token, version, product, optionNames = [], variants = [] }) {
  const productInput = { ...product };
  const productOptions = buildProductOptions(optionNames, variants);
  if (productOptions) productInput.productOptions = productOptions;

  const data = await shopifyGraphql(shop, token, PRODUCT_CREATE_MUTATION, { product: productInput }, version);
  const errs = data?.productCreate?.userErrors || [];
  if (errs.length) throw new Error(errs.map((e) => e.message).join("; "));
  const created = data?.productCreate?.product;
  if (!created?.id) throw new Error("productCreate returned no product ID");

  if (variants.length > 0) {
    const bulkInputs = buildVariantsBulkInput(optionNames, variants);
    const vData = await shopifyGraphql(shop, token, PRODUCT_VARIANTS_BULK_CREATE_MUTATION, {
      productId: created.id,
      variants: bulkInputs,
      strategy: "REMOVE_STANDALONE_VARIANT",
    }, version);
    const vErrs = vData?.productVariantsBulkCreate?.userErrors || [];
    if (vErrs.length) throw new Error(vErrs.map((e) => e.message).join("; "));
  }

  return { id: created.id.split("/").pop(), gid: created.id };
}
