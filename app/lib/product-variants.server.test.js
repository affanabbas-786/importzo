import { describe, it, expect, vi } from "vitest";
import { buildProductOptions, buildVariantsBulkInput, createProductWithVariants } from "./product-variants.server.js";

describe("buildProductOptions", () => {
  it("returns undefined when there are no option names", () => {
    expect(buildProductOptions([], [])).toBeUndefined();
    expect(buildProductOptions(undefined, [])).toBeUndefined();
  });

  it("collects unique values per option position across variants", () => {
    const variants = [
      { options: ["Small", "Red"] },
      { options: ["Medium", "Red"] },
      { options: ["Small", "Blue"] },
    ];
    const result = buildProductOptions(["Size", "Color"], variants);
    expect(result).toEqual([
      { name: "Size", values: [{ name: "Small" }, { name: "Medium" }] },
      { name: "Color", values: [{ name: "Red" }, { name: "Blue" }] },
    ]);
  });

  it("falls back to a placeholder value if no variant supplies one for an option", () => {
    const result = buildProductOptions(["Size"], [{ options: [] }]);
    expect(result).toEqual([{ name: "Size", values: [{ name: "Default" }] }]);
  });
});

describe("buildVariantsBulkInput", () => {
  it("builds optionValues paired with the correct option name by position", () => {
    const result = buildVariantsBulkInput(["Size", "Color"], [{ options: ["Small", "Red"], price: "10.00" }]);
    expect(result[0].optionValues).toEqual([
      { optionName: "Size", name: "Small" },
      { optionName: "Color", name: "Red" },
    ]);
  });

  it("omits optionValues entirely for a product with no options", () => {
    const result = buildVariantsBulkInput([], [{ price: "10.00" }]);
    expect(result[0].optionValues).toBeUndefined();
  });

  it("nests sku, requiresShipping, and weight under inventoryItem (not directly on the variant)", () => {
    const result = buildVariantsBulkInput([], [{
      price: "10.00", sku: "SKU-1", requiresShipping: true, weight: "1.5", weightUnit: "kilograms",
    }]);
    expect(result[0].sku).toBeUndefined();
    expect(result[0].requiresShipping).toBeUndefined();
    expect(result[0].weight).toBeUndefined();
    expect(result[0].inventoryItem).toEqual({
      sku: "SKU-1",
      requiresShipping: true,
      measurement: { weight: { value: 1.5, unit: "KILOGRAMS" } },
    });
  });

  it("uppercases inventoryPolicy and weight unit", () => {
    const result = buildVariantsBulkInput([], [{ inventoryPolicy: "deny", weight: 2, weightUnit: "grams" }]);
    expect(result[0].inventoryPolicy).toBe("DENY");
    expect(result[0].inventoryItem.measurement.weight.unit).toBe("GRAMS");
  });

  it("builds inventoryQuantities only when both quantity and locationId are present", () => {
    const withLocation = buildVariantsBulkInput([], [{ inventoryQuantity: 5, locationId: "gid://shopify/Location/1" }]);
    expect(withLocation[0].inventoryQuantities).toEqual([{ availableQuantity: 5, locationId: "gid://shopify/Location/1" }]);

    const withoutLocation = buildVariantsBulkInput([], [{ inventoryQuantity: 5 }]);
    expect(withoutLocation[0].inventoryQuantities).toBeUndefined();
  });

  it("passes through price, compareAtPrice, taxable, barcode unchanged", () => {
    const result = buildVariantsBulkInput([], [{ price: "9.99", compareAtPrice: "14.99", taxable: false, barcode: "012345" }]);
    expect(result[0]).toMatchObject({ price: "9.99", compareAtPrice: "14.99", taxable: false, barcode: "012345" });
  });
});

describe("createProductWithVariants", () => {
  function makeShopifyGraphqlMock({ productCreateHandler, variantsBulkCreateHandler } = {}) {
    return vi.fn(async (shop, token, query, variables) => {
      if (query.includes("mutation ProductCreate")) {
        if (productCreateHandler) return productCreateHandler(variables);
        return { productCreate: { product: { id: "gid://shopify/Product/1" }, userErrors: [] } };
      }
      if (query.includes("mutation ProductVariantsBulkCreate")) {
        if (variantsBulkCreateHandler) return variantsBulkCreateHandler(variables);
        return { productVariantsBulkCreate: { productVariants: [{ id: "gid://shopify/ProductVariant/1" }], userErrors: [] } };
      }
      throw new Error("unexpected query");
    });
  }

  it("sends ONLY plain fields plus productOptions to productCreate — never a bare options/variants field", async () => {
    let sentVariables = null;
    const shopifyGraphql = makeShopifyGraphqlMock({
      productCreateHandler: (variables) => {
        sentVariables = variables;
        return { productCreate: { product: { id: "gid://shopify/Product/1" }, userErrors: [] } };
      },
    });

    await createProductWithVariants({
      shopifyGraphql, shop: "shop.myshopify.com", token: "tok", version: "2025-10",
      product: { title: "Tee" },
      optionNames: ["Size"],
      variants: [{ options: ["Small"], price: "10.00" }],
    });

    expect(sentVariables.product).not.toHaveProperty("options");
    expect(sentVariables.product).not.toHaveProperty("variants");
    expect(sentVariables.product.productOptions).toEqual([{ name: "Size", values: [{ name: "Small" }] }]);
  });

  it("calls productVariantsBulkCreate with REMOVE_STANDALONE_VARIANT after productCreate succeeds", async () => {
    let bulkVariables = null;
    const shopifyGraphql = makeShopifyGraphqlMock({
      variantsBulkCreateHandler: (variables) => {
        bulkVariables = variables;
        return { productVariantsBulkCreate: { productVariants: [{ id: "gid://shopify/ProductVariant/1" }], userErrors: [] } };
      },
    });

    const result = await createProductWithVariants({
      shopifyGraphql, shop: "shop.myshopify.com", token: "tok", version: "2025-10",
      product: { title: "Tee" },
      optionNames: [],
      variants: [{ price: "10.00", sku: "SKU-1" }],
    });

    expect(result).toEqual({ id: "1", gid: "gid://shopify/Product/1" });
    expect(bulkVariables.productId).toBe("gid://shopify/Product/1");
    expect(bulkVariables.strategy).toBe("REMOVE_STANDALONE_VARIANT");
    expect(bulkVariables.variants[0].inventoryItem.sku).toBe("SKU-1");
  });

  it("does not call productVariantsBulkCreate when there are no variants", async () => {
    const shopifyGraphql = makeShopifyGraphqlMock();
    await createProductWithVariants({
      shopifyGraphql, shop: "shop.myshopify.com", token: "tok", version: "2025-10",
      product: { title: "Tee" }, optionNames: [], variants: [],
    });
    expect(shopifyGraphql).toHaveBeenCalledTimes(1);
  });

  it("throws on productCreate userErrors without calling productVariantsBulkCreate", async () => {
    const shopifyGraphql = makeShopifyGraphqlMock({
      productCreateHandler: () => ({ productCreate: { product: null, userErrors: [{ message: "Title can't be blank" }] } }),
    });
    await expect(createProductWithVariants({
      shopifyGraphql, shop: "s", token: "t", version: "2025-10", product: {}, variants: [{ price: "1" }],
    })).rejects.toThrow(/Title can't be blank/);
    expect(shopifyGraphql).toHaveBeenCalledTimes(1);
  });

  it("throws on productVariantsBulkCreate userErrors", async () => {
    const shopifyGraphql = makeShopifyGraphqlMock({
      variantsBulkCreateHandler: () => ({ productVariantsBulkCreate: { productVariants: [], userErrors: [{ field: ["price"], message: "Price is invalid" }] } }),
    });
    await expect(createProductWithVariants({
      shopifyGraphql, shop: "s", token: "t", version: "2025-10", product: { title: "Tee" }, variants: [{ price: "-1" }],
    })).rejects.toThrow(/Price is invalid/);
  });
});
