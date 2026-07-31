import { describe, it, expect } from "vitest";
import {
  WOOCOMMERCE_PRODUCT_ALIASES, detectWooCommerceCsv, buildWooCommerceProducts, maskStructuralColumns, slugify,
} from "./woocommerce-mapper.js";
import { smartMapColumns } from "./smart-mapper.js";

const SIMPLE_HEADERS = [
  "Type", "SKU", "Name", "Published", "Short description", "Description",
  "In stock?", "Stock", "Weight (kg)", "Sale price", "Regular price",
  "Categories", "Tags", "Images", "Parent",
];

function autoMap(headers, rows) {
  const { mapping } = smartMapColumns(maskStructuralColumns(headers), rows, WOOCOMMERCE_PRODUCT_ALIASES, { multiMap: ["image_src"] });
  return mapping;
}

describe("detectWooCommerceCsv", () => {
  it("detects a native WooCommerce export", () => {
    expect(detectWooCommerceCsv(SIMPLE_HEADERS)).toBe(true);
  });

  it("does not flag a generic Shopify-style CSV", () => {
    expect(detectWooCommerceCsv(["Title", "Handle", "Price", "SKU", "Option1 Value"])).toBe(false);
  });

  it("requires more than just a generic 'Type' header", () => {
    expect(detectWooCommerceCsv(["Type", "Notes"])).toBe(false);
  });
});

describe("buildWooCommerceProducts — simple products", () => {
  it("builds a single-variant product from one row", () => {
    const rows = [[
      "simple", "TS-100", "Cotton T-Shirt", "1", "A shirt", "<p>Soft cotton tee</p>",
      "1", "42", "0.3", "", "19.99", "Apparel > Shirts", "cotton, summer", "https://x.test/a.jpg", "",
    ]];
    const mapping = autoMap(SIMPLE_HEADERS, rows);
    const { products, warnings } = buildWooCommerceProducts({ headers: SIMPLE_HEADERS, dataRows: rows, mapping });

    expect(warnings).toEqual([]);
    expect(products).toHaveLength(1);
    const p = products[0];
    expect(p.title).toBe("Cotton T-Shirt");
    expect(p.body_html).toBe("<p>Soft cotton tee</p>");
    expect(p.product_type).toBe("Apparel");
    expect(p.tags).toContain("cotton");
    expect(p.tags).toContain("Shirts"); // second category folded into tags
    expect(p.images).toEqual(["https://x.test/a.jpg"]);
    expect(p.variants).toHaveLength(1);
    expect(p.variants[0]).toMatchObject({ price: "19.99", sku: "TS-100", inventory_quantity: 42, weight: 0.3, weight_unit: "KILOGRAMS" });
  });

  it("resolves Sale price as the effective price with Regular price as compareAtPrice", () => {
    const rows = [["simple", "TS-101", "Discounted Tee", "1", "", "", "1", "5", "", "12.00", "20.00", "", "", "", ""]];
    const mapping = autoMap(SIMPLE_HEADERS, rows);
    const { products } = buildWooCommerceProducts({ headers: SIMPLE_HEADERS, dataRows: rows, mapping });
    expect(products[0].variants[0]).toMatchObject({ price: "12.00", compareAtPrice: "20.00" });
  });

  it("ignores a Sale price that isn't actually lower than Regular price", () => {
    const rows = [["simple", "TS-102", "Weird Pricing", "1", "", "", "1", "5", "", "25.00", "20.00", "", "", "", ""]];
    const mapping = autoMap(SIMPLE_HEADERS, rows);
    const { products } = buildWooCommerceProducts({ headers: SIMPLE_HEADERS, dataRows: rows, mapping });
    expect(products[0].variants[0].price).toBe("20.00");
    expect(products[0].variants[0].compareAtPrice).toBeUndefined();
  });

  it("falls back to short description when description is empty", () => {
    const rows = [["simple", "TS-103", "No Long Desc", "1", "Short only", "", "1", "1", "", "", "9.99", "", "", "", ""]];
    const mapping = autoMap(SIMPLE_HEADERS, rows);
    const { products } = buildWooCommerceProducts({ headers: SIMPLE_HEADERS, dataRows: rows, mapping });
    expect(products[0].body_html).toBe("Short only");
  });

  it("treats a blank/unrecognized Type as simple", () => {
    const rows = [["", "TS-104", "No Type Column Value", "1", "", "", "1", "1", "", "", "9.99", "", "", "", ""]];
    const mapping = autoMap(SIMPLE_HEADERS, rows);
    const { products, warnings } = buildWooCommerceProducts({ headers: SIMPLE_HEADERS, dataRows: rows, mapping });
    expect(warnings).toEqual([]);
    expect(products).toHaveLength(1);
  });
});

describe("buildWooCommerceProducts — variable products", () => {
  const VAR_HEADERS = [
    ...SIMPLE_HEADERS,
    "Attribute 1 name", "Attribute 1 value(s)", "Attribute 2 name", "Attribute 2 value(s)",
  ];

  function pad(row) { return [...row]; }

  it("folds a variable parent + variation rows into one product with per-variant options", () => {
    const parentRow = pad([
      "variable", "HOODIE", "Zip Hoodie", "1", "", "<p>Warm hoodie</p>",
      "", "", "", "", "", "Apparel", "winter", "https://x.test/hoodie.jpg", "",
      "Size", "Small, Medium", "Color", "Black, Grey",
    ]);
    const var1 = pad([
      "variation", "HOODIE-S-BLK", "Zip Hoodie", "1", "", "",
      "1", "10", "0.6", "", "39.99", "", "", "", "id:1",
      "Size", "Small", "Color", "Black",
    ]);
    const var2 = pad([
      "variation", "HOODIE-M-GRY", "Zip Hoodie", "1", "", "",
      "1", "7", "0.65", "34.99", "39.99", "", "", "", "id:1",
      "Size", "Medium", "Color", "Grey",
    ]);
    const rows = [parentRow, var1, var2];
    const mapping = autoMap(VAR_HEADERS, rows);
    const { products, warnings } = buildWooCommerceProducts({ headers: VAR_HEADERS, dataRows: rows, mapping });

    expect(warnings).toEqual([]);
    expect(products).toHaveLength(1);
    const p = products[0];
    expect(p.title).toBe("Zip Hoodie");
    expect(p.option1_name).toBe("Size");
    expect(p.option2_name).toBe("Color");
    expect(p.variants).toHaveLength(2);
    expect(p.variants[0]).toMatchObject({ option1: "Small", option2: "Black", sku: "HOODIE-S-BLK", price: "39.99" });
    expect(p.variants[1]).toMatchObject({ option1: "Medium", option2: "Grey", sku: "HOODIE-M-GRY", price: "34.99", compareAtPrice: "39.99" });
  });

  it("warns and imports with a placeholder variant when a variable product has no variation rows", () => {
    const parentRow = pad([
      "variable", "LONE", "Orphan Variable", "1", "", "",
      "", "", "", "", "", "", "", "", "",
      "Size", "Small, Medium", "", "",
    ]);
    const mapping = autoMap(VAR_HEADERS, [parentRow]);
    const { products, warnings } = buildWooCommerceProducts({ headers: VAR_HEADERS, dataRows: [parentRow], mapping });
    expect(products).toHaveLength(1);
    expect(products[0].variants).toEqual([{}]);
    expect(warnings.some((w) => w.includes("no variation rows"))).toBe(true);
  });

  it("warns and skips a variation row with no preceding variable parent", () => {
    const orphanVariation = pad([
      "variation", "ORPHAN-1", "Ghost", "1", "", "",
      "1", "1", "", "", "10.00", "", "", "", "id:99",
      "Size", "Small", "", "",
    ]);
    const mapping = autoMap(VAR_HEADERS, [orphanVariation]);
    const { products, warnings } = buildWooCommerceProducts({ headers: VAR_HEADERS, dataRows: [orphanVariation], mapping });
    expect(products).toHaveLength(0);
    expect(warnings.some((w) => w.includes("no preceding variable product"))).toBe(true);
  });
});

describe("buildWooCommerceProducts — unsupported types", () => {
  it("skips grouped and external products with a warning instead of importing garbage", () => {
    const rows = [
      ["grouped", "G1", "Bundle", "1", "", "", "", "", "", "", "", "", "", "", ""],
      ["external", "E1", "Affiliate Item", "1", "", "", "", "", "", "", "", "", "", "", ""],
    ];
    const mapping = autoMap(SIMPLE_HEADERS, rows);
    const { products, warnings } = buildWooCommerceProducts({ headers: SIMPLE_HEADERS, dataRows: rows, mapping });
    expect(products).toHaveLength(0);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/grouped/);
    expect(warnings[1]).toMatch(/external/);
  });
});

describe("slugify / deterministic handles", () => {
  it("derives a stable handle from SKU when present", () => {
    const rows = [["simple", "TS-100", "Cotton T-Shirt", "1", "", "", "1", "1", "", "", "19.99", "", "", "", ""]];
    const mapping = autoMap(SIMPLE_HEADERS, rows);
    const { products } = buildWooCommerceProducts({ headers: SIMPLE_HEADERS, dataRows: rows, mapping });
    expect(products[0].handle).toBe(slugify("TS-100"));
  });

  it("falls back to the title when no SKU is present, so re-imports still dedupe", () => {
    const rows = [["simple", "", "Unbranded Widget", "1", "", "", "1", "1", "", "", "9.99", "", "", "", ""]];
    const mapping = autoMap(SIMPLE_HEADERS, rows);
    const { products } = buildWooCommerceProducts({ headers: SIMPLE_HEADERS, dataRows: rows, mapping });
    expect(products[0].handle).toBe("unbranded-widget");
  });

  it("produces the same handle across two separate builds of the same row (idempotent by construction)", () => {
    const rows = [["simple", "TS-200", "Repeat Import", "1", "", "", "1", "1", "", "", "9.99", "", "", "", ""]];
    const mapping = autoMap(SIMPLE_HEADERS, rows);
    const run1 = buildWooCommerceProducts({ headers: SIMPLE_HEADERS, dataRows: rows, mapping });
    const run2 = buildWooCommerceProducts({ headers: SIMPLE_HEADERS, dataRows: rows, mapping });
    expect(run1.products[0].handle).toBe(run2.products[0].handle);
  });
});

describe("WOOCOMMERCE_PRODUCT_ALIASES via smartMapColumns", () => {
  it("auto-maps every core WooCommerce column with reasonable confidence", () => {
    const rows = [["simple", "SKU1", "A Product", "1", "short", "long", "1", "5", "1.2", "9.00", "12.00", "Cat", "tag", "https://x.test/a.jpg", ""]];
    const mapping = autoMap(SIMPLE_HEADERS, rows);
    expect(mapping[2]).toBe("title");        // Name
    expect(mapping[5]).toBe("body_html");     // Description (not "Short description" — see maskStructuralColumns)
    expect(mapping[9]).toBe("sale_price");    // Sale price
    expect(mapping[10]).toBe("regular_price"); // Regular price
    expect(mapping[1]).toBe("sku");           // SKU
    expect(mapping[13]).toBe("image_src");    // Images
  });

  it("masks the Short description column out of scoring, so it never wins body_html over the real Description column", () => {
    const rows = [["simple", "SKU1", "A Product", "1", "short", "long description here", "1", "5", "", "", "", "", "", "", ""]];
    const mapping = autoMap(SIMPLE_HEADERS, rows);
    expect(mapping[4]).toBe(""); // Short description — masked, not scored
    expect(mapping[5]).toBe("body_html"); // Description wins cleanly
  });
});
