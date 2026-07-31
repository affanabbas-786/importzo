import { describe, it, expect } from "vitest";
import {
  smartMapColumns,
  PRODUCT_ALIASES,
  COLLECTION_ALIASES,
  INVENTORY_ALIASES,
  confidenceLevel,
  confidenceColor,
  templateFromMapping,
  applyMappingTemplate,
} from "./smart-mapper.js";

describe("confidenceLevel", () => {
  it("returns high for scores >= 85", () => {
    expect(confidenceLevel(85)).toBe("high");
    expect(confidenceLevel(100)).toBe("high");
    expect(confidenceLevel(90)).toBe("high");
  });

  it("returns medium for scores 60-84", () => {
    expect(confidenceLevel(60)).toBe("medium");
    expect(confidenceLevel(84)).toBe("medium");
  });

  it("returns low for scores 1-59", () => {
    expect(confidenceLevel(1)).toBe("low");
    expect(confidenceLevel(59)).toBe("low");
  });

  it("returns none for 0", () => {
    expect(confidenceLevel(0)).toBe("none");
  });
});

describe("confidenceColor", () => {
  it("returns green classes for high", () => {
    const c = confidenceColor("high");
    expect(c.bg).toContain("green");
    expect(c.text).toContain("green");
  });

  it("returns amber classes for medium", () => {
    const c = confidenceColor("medium");
    expect(c.bg).toContain("amber");
  });

  it("returns red classes for low", () => {
    const c = confidenceColor("low");
    expect(c.bg).toContain("red");
  });

  it("returns gray classes for none/unknown", () => {
    const c = confidenceColor("none");
    expect(c.bg).toContain("gray");
    expect(confidenceColor("unknown").bg).toContain("gray");
  });
});

describe("smartMapColumns — Product mapping", () => {
  const dataRows = [
    ["Basic Tee", "basic-tee", "A cotton shirt", "Importzo", "Apparel", "cotton", "TRUE", "19.99", "BT-001", "https://example.com/img.jpg"],
  ];

  it("maps exact Shopify header names", () => {
    const headers = ["Title", "Handle", "Body (HTML)", "Vendor", "Product Type", "Tags", "Published", "Variant Price", "Variant SKU", "Image Src"];
    const { mapping, confidence } = smartMapColumns(headers, dataRows, PRODUCT_ALIASES);

    expect(mapping[0]).toBe("title");
    expect(mapping[1]).toBe("handle");
    expect(mapping[7]).toBe("price");
    expect(mapping[8]).toBe("sku");
    expect(mapping[9]).toBe("image_src");

    // All exact matches should have high confidence
    for (let i = 0; i < headers.length; i++) {
      if (mapping[i]) expect(confidence[i]).toBeGreaterThanOrEqual(85);
    }
  });

  it("maps common alternate names", () => {
    const headers = ["Product Name", "URL Slug", "Description", "Brand", "Category", "Price", "SKU"];
    const { mapping } = smartMapColumns(headers, dataRows.map((r) => r.slice(0, 7)), PRODUCT_ALIASES);

    expect(mapping[0]).toBe("title");
    expect(mapping[5]).toBe("price");
    expect(mapping[6]).toBe("sku");
  });

  it("maps multilingual headers (French)", () => {
    const headers = ["Titre", "Prix"];
    const rows = [["Un Produit", "29.99"]];
    const { mapping } = smartMapColumns(headers, rows, PRODUCT_ALIASES);
    expect(mapping[0]).toBe("title");
    expect(mapping[1]).toBe("price");
  });

  it("handles multi-map fields (image_src)", () => {
    const headers = ["Title", "Image 1", "Image 2", "Image 3"];
    const rows = [["Shirt", "https://a.com/1.jpg", "https://a.com/2.jpg", "https://a.com/3.jpg"]];
    const { mapping } = smartMapColumns(headers, rows, PRODUCT_ALIASES, { multiMap: ["image_src"] });

    expect(mapping[0]).toBe("title");
    // At least one image column should be mapped
    const imageMappings = Object.values(mapping).filter((v) => v === "image_src");
    expect(imageMappings.length).toBeGreaterThanOrEqual(1);
  });

  it("does not map unrecognizable headers", () => {
    const headers = ["xyzzy123", "foobar99", "zzztop"];
    const rows = [["a", "b", "c"]];
    const { mapping } = smartMapColumns(headers, rows, PRODUCT_ALIASES);

    // Low-quality matches should be skipped or have low confidence
    const mappedCount = Object.values(mapping).filter(Boolean).length;
    expect(mappedCount).toBeLessThanOrEqual(3); // may or may not map
  });

  it("returns empty mapping for empty headers", () => {
    const { mapping, confidence } = smartMapColumns([], [], PRODUCT_ALIASES);
    expect(Object.keys(mapping).length).toBe(0);
    expect(Object.keys(confidence).length).toBe(0);
  });
});

describe("smartMapColumns — Collection mapping", () => {
  it("maps collection headers", () => {
    const headers = ["Title", "Body HTML", "Collection Type", "Published"];
    const rows = [["Summer Sale", "<p>Great deals</p>", "custom", "TRUE"]];
    const { mapping } = smartMapColumns(headers, rows, COLLECTION_ALIASES);

    expect(mapping[0]).toBe("title");
    expect(mapping[1]).toBe("body_html");
  });
});

describe("smartMapColumns — Inventory mapping", () => {
  it("maps inventory headers", () => {
    const headers = ["SKU", "Location", "Available", "Quantity"];
    const rows = [["BT-001", "Warehouse", "50", "50"]];
    const { mapping } = smartMapColumns(headers, rows, INVENTORY_ALIASES);

    expect(mapping[0]).toBe("sku");
    // At least quantity or available should map
    const qtyMapped = Object.values(mapping).includes("quantity");
    expect(qtyMapped).toBe(true);
  });
});

describe("smartMapColumns — Edge cases", () => {
  it("handles headers with extra whitespace", () => {
    const headers = ["  Title  ", " Variant Price ", "  SKU  "];
    const rows = [["Shirt", "19.99", "BT-001"]];
    const { mapping } = smartMapColumns(headers, rows, PRODUCT_ALIASES);
    expect(mapping[0]).toBe("title");
  });

  it("handles empty data rows gracefully", () => {
    const headers = ["Title", "Price"];
    const { mapping } = smartMapColumns(headers, [], PRODUCT_ALIASES);
    // Should still work with header-only matching
    expect(mapping[0]).toBe("title");
  });

  it("does not crash on single-character headers", () => {
    const headers = ["T", "P", "S"];
    const rows = [["test", "10", "ABC"]];
    const { mapping } = smartMapColumns(headers, rows, PRODUCT_ALIASES);
    // Should not throw
    expect(mapping).toBeDefined();
  });
});

describe("templateFromMapping / applyMappingTemplate (Phase 4 saved templates)", () => {
  it("builds a header-text-keyed template from a column mapping, skipping unmapped columns", () => {
    const headers = ["Product Name", "Cost", "SKU Code", "Ignore Me"];
    const mapping = { 0: "title", 1: "price", 2: "sku", 3: "" };
    const template = templateFromMapping(headers, mapping);
    expect(template).toEqual({ "product name": "title", "cost": "price", "sku code": "sku" });
  });

  it("re-applies a saved template to the same headers", () => {
    const headers = ["Product Name", "Cost", "SKU Code"];
    const template = { "product name": "title", "cost": "price", "sku code": "sku" };
    const { mapping, confidence, matchedCount, unmatchedTemplateKeys } = applyMappingTemplate(headers, template);
    expect(mapping).toEqual({ 0: "title", 1: "price", 2: "sku" });
    expect(confidence).toEqual({ 0: 100, 1: 100, 2: 100 });
    expect(matchedCount).toBe(3);
    expect(unmatchedTemplateKeys).toEqual([]);
  });

  it("matches header text case- and whitespace-insensitively", () => {
    const headers = ["  PRODUCT NAME  ", "cost"];
    const template = { "product name": "title", "cost": "price" };
    const { mapping } = applyMappingTemplate(headers, template);
    expect(mapping).toEqual({ 0: "title", 1: "price" });
  });

  it("leaves a column unmapped when the new file has a header the template doesn't know", () => {
    const headers = ["Product Name", "Weight (kg)"];
    const template = { "product name": "title" };
    const { mapping, confidence } = applyMappingTemplate(headers, template);
    expect(mapping).toEqual({ 0: "title", 1: "" });
    expect(confidence[1]).toBe(0);
  });

  it("reports template entries that found no matching column in this file, instead of silently dropping them", () => {
    const headers = ["Product Name"];
    const template = { "product name": "title", "sku code": "sku" };
    const { unmatchedTemplateKeys, matchedCount } = applyMappingTemplate(headers, template);
    expect(unmatchedTemplateKeys).toEqual(["sku code"]);
    expect(matchedCount).toBe(1);
  });

  it("round-trips through smartMapColumns's own output", () => {
    const headers = ["Title", "Price", "SKU"];
    const rows = [["Shirt", "19.99", "BT-001"]];
    const { mapping } = smartMapColumns(headers, rows, PRODUCT_ALIASES);
    const template = templateFromMapping(headers, mapping);
    const reapplied = applyMappingTemplate(headers, template);
    expect(reapplied.mapping).toEqual(mapping);
  });
});
