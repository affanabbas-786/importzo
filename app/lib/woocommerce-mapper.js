// ═══════════════════════════════════════════════════════════════════
// WooCommerce → Shopify cross-platform import (Phase 4).
//
// WooCommerce's native Product CSV Exporter writes ONE ROW PER VARIATION,
// not one row per product. A variable product appears as:
//   - one "variable" row carrying the shared product data (Name,
//     Description, Categories, Tags, Images, Published) but no price/SKU
//     of its own, and each "Attribute N value(s)" holding a COMMA-
//     SEPARATED LIST of every possible value,
//   - followed by N "variation" rows, each with its own SKU/price/stock
//     and a SINGLE value per "Attribute N value(s)" (the one this
//     variation represents), linked back via the "Parent" column.
// A "simple" product is just one self-contained row.
//
// This module has two responsibilities that are deliberately kept
// separate:
//   1. DESCRIPTIVE field mapping (title, price, sku, images, ...) reuses
//      the same smartMapColumns engine and mapping-template
//      infrastructure as the generic CSV importer (WOOCOMMERCE_PRODUCT_ALIASES
//      below) — a merchant reviews/adjusts it exactly like a normal
//      import, and can save it as a template (importType="woocommerce").
//   2. STRUCTURAL folding (which rows belong to the same product, which
//      column is "Type"/"Parent"/the per-attribute value) is NOT a
//      column-to-Shopify-field choice — there's no Shopify field called
//      "Type" — so it's auto-detected by fixed header matching rather
//      than exposed as a remappable field.
// ═══════════════════════════════════════════════════════════════════

// "Short description" is deliberately NOT a scored alias target here (see
// SHORT_DESCRIPTION_ALIASES below) — it's a fixed, well-known WooCommerce
// column name detected directly, the same way Type/Parent are. Scoring it
// against body_html's "description" alias would tie almost every time
// (both are free-text columns, and the "text" data-type boost in
// smart-mapper.js favors body_html generically), with the winner decided
// by column order rather than which header is the better match — exactly
// the kind of silent misassignment a merchant wouldn't notice until their
// product descriptions were swapped.
export const WOOCOMMERCE_PRODUCT_ALIASES = {
  title: ["name", "productname", "title"],
  body_html: ["description", "productdescription"],
  vendor: ["brand", "brands", "manufacturer"],
  categories: ["categories", "category", "productcategory"],
  tags: ["tags"],
  regular_price: ["regularprice", "price"],
  sale_price: ["saleprice"],
  sku: ["sku"],
  barcode: ["gtin", "upc", "ean", "barcode"],
  inventory_quantity: ["stock", "quantity"],
  weight: ["weight", "weightkg", "weightlbs", "weightg", "weightoz"],
  published: ["published", "status"],
  image_src: ["images", "image", "imageurl"],
};

export const WOOCOMMERCE_FIELDS = [
  { value: "", label: "-- Skip --" },
  { value: "title", label: "Title (Name)" },
  { value: "body_html", label: "Description" },
  { value: "vendor", label: "Vendor / Brand" },
  { value: "categories", label: "Categories" },
  { value: "tags", label: "Tags" },
  { value: "regular_price", label: "Regular Price" },
  { value: "sale_price", label: "Sale Price" },
  { value: "sku", label: "SKU" },
  { value: "barcode", label: "Barcode / GTIN" },
  { value: "inventory_quantity", label: "Stock Quantity" },
  { value: "weight", label: "Weight" },
  { value: "published", label: "Published" },
  { value: "image_src", label: "Images (multi)" },
];

// Fixed structural column names WooCommerce's exporter uses. These are
// never user-remappable — see the module comment above.
const STRUCTURAL_ALIASES = {
  type: ["type"],
  parent: ["parent"],
  shortDescription: ["shortdescription", "excerpt"],
};

function normalize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Deterministic handle derivation so re-importing the same WooCommerce CSV
// resolves to the same Shopify handle every run — the new route dedupes by
// handle exactly like app.product-importer.jsx (Phase 1 idempotency), which
// only works if the same source row always produces the same handle.
export function slugify(text) {
  return (text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 255);
}

function findColumn(headers, aliases) {
  const normalized = headers.map(normalize);
  for (const alias of aliases) {
    const idx = normalized.indexOf(normalize(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

// Detects "Attribute 1 name" / "Attribute 1 value(s)" pairs (WooCommerce
// supports an arbitrary number; 3 is the practical cap since Shopify
// products support at most 3 options).
function findAttributeColumns(headers) {
  const attrs = [];
  for (let n = 1; n <= 3; n++) {
    const nameIdx = findColumn(headers, [`attribute${n}name`]);
    const valueIdx = findColumn(headers, [`attribute${n}value(s)`, `attribute${n}values`, `attribute${n}value`]);
    if (nameIdx === -1 && valueIdx === -1) break;
    attrs.push({ nameIdx, valueIdx });
  }
  return attrs;
}

/**
 * Blanks out the structural columns (Type, Parent, Short description)
 * before running smartMapColumns for the descriptive-field mapping step.
 *
 * Without this, "Short description" and "Description" both compete for
 * the single body_html slot — both are free-text columns, and
 * smart-mapper.js's data-type boost favors body_html for ANY plain-text
 * column, so both score at or near the cap. Ties go to whichever column
 * comes first, which in WooCommerce's native export column order is
 * "Short description" — meaning body_html would silently grab the SHORT
 * description instead of the full one on every native export, not just
 * an edge case. Short description is handled separately as a fixed
 * fallback (see buildWooCommerceProducts) instead of a scored alias, so
 * it must never be allowed to win that scoring competition in the first
 * place.
 */
export function maskStructuralColumns(headers) {
  const typeIdx = findColumn(headers, STRUCTURAL_ALIASES.type);
  const parentIdx = findColumn(headers, STRUCTURAL_ALIASES.parent);
  const shortDescIdx = findColumn(headers, STRUCTURAL_ALIASES.shortDescription);
  const attrCols = findAttributeColumns(headers);
  const masked = new Set([typeIdx, parentIdx, shortDescIdx]);
  attrCols.forEach((c) => { masked.add(c.nameIdx); masked.add(c.valueIdx); });
  return headers.map((h, i) => (masked.has(i) ? "" : h));
}

/**
 * Confidence check used to auto-suggest this importer / show a
 * "WooCommerce format detected" hint. Requires the one column WooCommerce
 * always writes ("Type") plus at least one other hallmark column, since
 * "Type" alone is too generic a header name to be conclusive.
 */
export function detectWooCommerceCsv(headers) {
  const hasType = findColumn(headers, STRUCTURAL_ALIASES.type) !== -1;
  if (!hasType) return false;
  const hallmarks = ["sku", "regularprice", "attribute1name", "instock?", "shortdescription"];
  const normalized = headers.map(normalize);
  const hallmarkHits = hallmarks.filter((h) => normalized.includes(normalize(h))).length;
  return hallmarkHits >= 1;
}

function weightUnitFromHeader(headers, colIndex) {
  const header = (headers[colIndex] || "").toLowerCase();
  if (header.includes("lbs") || header.includes("lb")) return "POUNDS";
  if (header.includes("(g)") || /\bgrams?\b/.test(header)) return "GRAMS";
  if (header.includes("oz")) return "OUNCES";
  return "KILOGRAMS"; // WooCommerce's default export unit
}

// Applies a colIndex->field mapping to one row, honoring multiMap fields
// (image_src) by collecting every mapped column into an array instead of
// overwriting. Mirrors the same convention as app.product-importer.jsx's
// getGroupedProducts.
function extractMappedRow(headers, mapping, row) {
  const obj = {};
  const images = [];
  Object.entries(mapping).forEach(([colIndex, field]) => {
    if (!field) return;
    const value = (row[colIndex] || "").trim();
    if (!value) return;
    if (field === "image_src") {
      value.split(/[,|]/).map((u) => u.trim()).filter(Boolean).forEach((u) => {
        if (!images.includes(u)) images.push(u);
      });
    } else {
      obj[field] = value;
    }
  });
  obj._images = images;
  return obj;
}

function resolvePricing(mapped) {
  const regular = parseFloat(mapped.regular_price);
  const sale = parseFloat(mapped.sale_price);
  const hasRegular = !isNaN(regular);
  const hasSale = !isNaN(sale) && sale > 0;

  if (hasSale && hasRegular && sale < regular) {
    return { price: sale.toFixed(2), compareAtPrice: regular.toFixed(2) };
  }
  if (hasRegular) return { price: regular.toFixed(2), compareAtPrice: undefined };
  if (hasSale) return { price: sale.toFixed(2), compareAtPrice: undefined };
  return { price: undefined, compareAtPrice: undefined };
}

function buildVariantFromRow(headers, mapping, row, weightColIndex) {
  const mapped = extractMappedRow(headers, mapping, row);
  const { price, compareAtPrice } = resolvePricing(mapped);
  const variant = {};
  if (price !== undefined) variant.price = price;
  if (compareAtPrice !== undefined) variant.compareAtPrice = compareAtPrice;
  if (mapped.sku) variant.sku = mapped.sku;
  if (mapped.barcode) variant.barcode = mapped.barcode;
  if (mapped.inventory_quantity && !isNaN(parseInt(mapped.inventory_quantity, 10))) {
    variant.inventory_quantity = parseInt(mapped.inventory_quantity, 10);
  }
  if (mapped.weight && !isNaN(parseFloat(mapped.weight))) {
    variant.weight = parseFloat(mapped.weight);
    variant.weight_unit = weightColIndex >= 0 ? weightUnitFromHeader(headers, weightColIndex) : "KILOGRAMS";
  }
  return variant;
}

/**
 * Folds WooCommerce's row-per-variation CSV into the same canonical
 * product shape the generic importer builds (title, body_html, vendor,
 * product_type, tags, handle, published, variants[], images[]), so both
 * feed the same productCreate + productVariantsBulkCreate path
 * (product-variants.server.js).
 */
export function buildWooCommerceProducts({ headers, dataRows, mapping }) {
  const typeIdx = findColumn(headers, STRUCTURAL_ALIASES.type);
  const shortDescIdx = findColumn(headers, STRUCTURAL_ALIASES.shortDescription);
  const weightColIndex = Object.entries(mapping).find(([, f]) => f === "weight")?.[0];
  const attrCols = findAttributeColumns(headers);
  const shortDescOf = (row) => (shortDescIdx >= 0 ? (row[shortDescIdx] || "").trim() : "");

  const products = [];
  const warnings = [];
  let currentParent = null; // { product, attrNames: [name|null,...] }

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const type = (typeIdx >= 0 ? row[typeIdx] : "simple").trim().toLowerCase() || "simple";

    if (type === "grouped" || type === "external" || type === "external/affiliate") {
      warnings.push(`Row ${i + 2}: WooCommerce product type "${type}" has no Shopify equivalent — skipped.`);
      currentParent = null;
      continue;
    }

    if (type === "variable") {
      const mapped = extractMappedRow(headers, mapping, row);
      const product = {
        title: mapped.title || "Untitled Product",
        body_html: mapped.body_html || shortDescOf(row),
        vendor: mapped.vendor || "",
        tags: mapped.tags || "",
        published: mapped.published,
        images: mapped._images || [],
        variants: [],
      };
      // Categories: first becomes product_type (Shopify's closest single-value
      // equivalent), the rest fold into tags so they aren't lost entirely.
      if (mapped.categories) {
        const cats = mapped.categories.split(/[,>]/).map((c) => c.trim()).filter(Boolean);
        if (cats.length) {
          product.product_type = cats[0];
          const extra = cats.slice(1).filter((c) => !product.tags.split(",").map((t) => t.trim()).includes(c));
          if (extra.length) product.tags = [product.tags, extra.join(", ")].filter(Boolean).join(", ");
        }
      }
      const attrNames = attrCols.map((c) => (c.nameIdx >= 0 ? (row[c.nameIdx] || "").trim() : ""));
      attrNames.forEach((name, idx) => {
        if (name) product[`option${idx + 1}_name`] = name;
      });
      currentParent = { product, attrNames };
      products.push(product);
      continue;
    }

    if (type === "variation") {
      // WooCommerce links a variation to its parent via "Parent", whose
      // value is commonly "id:<parent_id>" or the parent's SKU — neither
      // of which we can resolve exactly without the parent's numeric post
      // ID (not present in the export). In practice WooCommerce's exporter
      // always keeps a variable product's variations immediately following
      // it, so falling back to "the most recently seen variable parent" is
      // reliable for a native, unedited export; a merchant-reordered CSV is
      // the one case this can misattribute, which is why it's a warning
      // rather than a silent skip when there's no parent to attach to.
      if (!currentParent) {
        warnings.push(`Row ${i + 2}: variation row with no preceding variable product — skipped.`);
        continue;
      }
      const variant = buildVariantFromRow(headers, mapping, row, weightColIndex);
      currentParent.attrNames.forEach((name, idx) => {
        if (!name) return;
        const col = attrCols[idx];
        const value = col.valueIdx >= 0 ? (row[col.valueIdx] || "").trim() : "";
        if (value) variant[`option${idx + 1}`] = value;
      });
      currentParent.product.variants.push(variant);
      // Per-variation images (rare in native exports, but honor them if present).
      const mapped = extractMappedRow(headers, mapping, row);
      (mapped._images || []).forEach((url) => {
        if (!currentParent.product.images.includes(url)) currentParent.product.images.push(url);
      });
      continue;
    }

    // "simple" (or unrecognized/blank type — treat as simple, matching
    // WooCommerce's own default when the column is absent).
    const mapped = extractMappedRow(headers, mapping, row);
    const product = {
      title: mapped.title || "Untitled Product",
      body_html: mapped.body_html || shortDescOf(row),
      vendor: mapped.vendor || "",
      tags: mapped.tags || "",
      published: mapped.published,
      images: mapped._images || [],
      variants: [buildVariantFromRow(headers, mapping, row, weightColIndex)],
    };
    if (mapped.categories) {
      const cats = mapped.categories.split(/[,>]/).map((c) => c.trim()).filter(Boolean);
      if (cats.length) {
        product.product_type = cats[0];
        const extra = cats.slice(1).filter((c) => !product.tags.split(",").map((t) => t.trim()).includes(c));
        if (extra.length) product.tags = [product.tags, extra.join(", ")].filter(Boolean).join(", ");
      }
    }
    products.push(product);
    currentParent = null;
  }

  // A "variable" product whose variation rows never showed up (e.g. an
  // export filtered to exclude variations) has product-level data but zero
  // variants — flag it rather than silently importing a priceless product.
  for (const p of products) {
    if (p.variants.length === 0) {
      warnings.push(`"${p.title}": no variation rows found for this variable product — imported with no price/SKU.`);
      p.variants.push({});
    }
    // Deterministic handle (SKU preferred, falls back to title) so a
    // re-run of the same CSV dedupes against what a prior run created,
    // instead of minting duplicates every time.
    p.handle = slugify(p.variants[0]?.sku || p.title);
  }

  return { products, warnings };
}
