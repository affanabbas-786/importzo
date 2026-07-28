import { useState, useCallback, useRef, useEffect } from "react";
import { useFetcher, useRouteError, Link } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate, apiVersion } from "../shopify.server";
import prisma from "../db.server";
import { shopifyFetch } from "../lib/shopify-api.server";
import { parseCSV } from "../lib/csv-parser";
import { smartMapColumns, PRODUCT_ALIASES, confidenceLevel, confidenceColor } from "../lib/smart-mapper";
import { FileSourcePicker, AISummary, generateMappingSummary, generateImportResultSummary } from "../components/ui";
import { FriendlyErrorBoundary } from "../components/FriendlyErrorBoundary";

// ═══════════════════════════════════════════════════════════════════
// Shopify field definitions — dynamic images (no hardcoded limit)
// ═══════════════════════════════════════════════════════════════════
const SHOPIFY_FIELDS = [
  { value: "", label: "-- Skip --" },
  { value: "title", label: "Title" },
  { value: "handle", label: "Handle" },
  { value: "body_html", label: "Description (HTML)" },
  { value: "vendor", label: "Vendor" },
  { value: "product_type", label: "Product Type" },
  { value: "tags", label: "Tags" },
  { value: "published", label: "Published" },
  { value: "option1_name", label: "Option1 Name" },
  { value: "option1_value", label: "Option1 Value" },
  { value: "option2_name", label: "Option2 Name" },
  { value: "option2_value", label: "Option2 Value" },
  { value: "option3_name", label: "Option3 Name" },
  { value: "option3_value", label: "Option3 Value" },
  { value: "price", label: "Price" },
  { value: "sku", label: "SKU" },
  { value: "barcode", label: "Barcode" },
  { value: "inventory_quantity", label: "Inventory Quantity" },
  { value: "weight", label: "Weight" },
  { value: "weight_unit", label: "Weight Unit" },
  { value: "image_src", label: "Image Src (multi)" },
  { value: "video_src", label: "Video URL (multi)" },
  { value: "variant_inventory_policy", label: "Variant Inventory Policy" },
  { value: "variant_fulfillment_service", label: "Variant Fulfillment Service" },
];

// ═══════════════════════════════════════════════════════════════════
// Auto-detect column mapping — powered by smart-mapper AI engine
// ═══════════════════════════════════════════════════════════════════
function autoDetectMapping(headers, dataRows) {
  return smartMapColumns(headers, dataRows || [], PRODUCT_ALIASES, {
    multiMap: ["image_src", "video_src"],
  });
}

// ═══════════════════════════════════════════════════════════════════
// Loader — authenticate on page load (prevents invalid token errors)
// ═══════════════════════════════════════════════════════════════════
export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

// ═══════════════════════════════════════════════════════════════════
// Server Action — uses correct API version from shopify.server config
// ═══════════════════════════════════════════════════════════════════
export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  let products;
  try {
    products = JSON.parse(formData.get("products"));
  } catch {
    return { results: [], successCount: 0, errorCount: 1, status: "failed", error: "Invalid product data received" };
  }
  const fileName = formData.get("fileName");

  const results = [];
  let successCount = 0;
  let errorCount = 0;

  const shopDomain = session.shop;
  const accessToken = session.accessToken;
  const version = apiVersion || "2025-10";

  // Fetch default location for inventory quantity assignment
  let defaultLocationId = null;
  try {
    const locRes = await shopifyFetch(`https://${shopDomain}/admin/api/${version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query: `{ locations(first: 1) { edges { node { id } } } }` }),
    });
    const locData = await locRes.json();
    defaultLocationId = locData?.data?.locations?.edges?.[0]?.node?.id || null;
  } catch { /* non-fatal */ }

  // Bounded concurrency (mirrors migration-worker.server.js's CREATE_CONCURRENCY)
  // instead of one fully sequential await-per-product loop — meaningfully
  // shortens wall-clock time for large CSV imports without unbounded parallelism.
  const CONCURRENCY = 5;

  // Idempotency: re-importing the same CSV (e.g. after a retry, or a
  // merchant re-uploading by mistake) must not create duplicate products.
  // A product's handle is stable and unique per store, so it's the
  // dedupe key — mirrors the same handle-lookup pattern used by the
  // clone/migration flow (app.transfer.jsx, migration-worker.server.js).
  async function findExistingProductByHandle(handle) {
    if (!handle) return null;
    try {
      const res = await shopifyFetch(`https://${shopDomain}/admin/api/${version}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({ query: `{ products(first: 1, query: "handle:${handle}") { edges { node { id } } } }` }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const node = data?.data?.products?.edges?.[0]?.node;
      return node ? { id: node.id.split("/").pop() } : null;
    } catch {
      return null;
    }
  }

  async function processProduct(product, i) {
    try {
      if (product.handle) {
        const existing = await findExistingProductByHandle(product.handle);
        if (existing) {
          return {
            row: i + 1,
            title: product.title,
            status: "success",
            productId: existing.id,
            variantCount: 0,
            videoNote: " (Skipped — a product with this handle already exists)",
            skipped: true,
          };
        }
      }

      const productData = {
        title: product.title || "Untitled Product",
      };

      if (product.body_html) productData.body_html = product.body_html;
      if (product.vendor) productData.vendor = product.vendor;
      if (product.product_type)
        productData.product_type = product.product_type;
      if (product.tags) productData.tags = product.tags;
      if (product.handle) productData.handle = product.handle;
      if (product.published !== undefined && product.published !== "") {
        productData.published = ["true", "yes", "1"].includes(
          product.published.toLowerCase(),
        );
      }

      // Build options from option names
      const hasOption1 = product.variants?.some((v) => v.option1);
      const hasOption2 = product.variants?.some((v) => v.option2);
      const hasOption3 = product.variants?.some((v) => v.option3);

      const options = [];
      if (hasOption1)
        options.push({ name: product.option1_name || "Option 1" });
      if (hasOption2)
        options.push({ name: product.option2_name || "Option 2" });
      if (hasOption3)
        options.push({ name: product.option3_name || "Option 3" });
      if (options.length > 0) productData.options = options;

      // Build variants
      const warnings = [];
      if (product.variants && product.variants.length > 0) {
        productData.variants = product.variants.map((v) => {
          const variant = {};
          if (v.option1) variant.option1 = v.option1;
          if (v.option2) variant.option2 = v.option2;
          if (v.option3) variant.option3 = v.option3;
          if (v.price) {
            const parsed = parseFloat(v.price);
            if (isNaN(parsed)) {
              warnings.push(`Invalid price "${v.price}" set to 0.00`);
              variant.price = "0.00";
            } else {
              variant.price = parsed.toFixed(2);
            }
          }
          if (v.sku) variant.sku = v.sku;
          if (v.barcode) variant.barcode = v.barcode;
          if (v.inventory_quantity)
            variant.inventory_quantity = parseInt(v.inventory_quantity, 10);
          if (v.weight) variant.weight = parseFloat(v.weight);
          if (v.weight_unit) variant.weight_unit = v.weight_unit;
          if (v.inventory_policy)
            variant.inventory_policy = v.inventory_policy;
          if (v.fulfillment_service)
            variant.fulfillment_service = v.fulfillment_service;
          return variant;
        });
      }

      // Build images — deduplicated, validated, capped at Shopify's 250 limit
      if (product.images && product.images.length > 0) {
        const seen = new Set();
        const validImages = [];
        for (const src of product.images) {
          const trimmed = (src || "").trim();
          if (trimmed && /^https?:\/\//i.test(trimmed) && !seen.has(trimmed)) {
            seen.add(trimmed);
            validImages.push(trimmed);
          }
        }
        if (validImages.length > 250) {
          warnings.push(
            `${validImages.length} images found, capped to Shopify limit of 250`,
          );
        }
        const capped = validImages.slice(0, 250);
        if (capped.length > 0) {
          productData.images = capped.map((url) => ({ src: url }));
        }
      }

      // Build GraphQL ProductInput from productData
      const gqlInput = { title: productData.title };
      if (productData.body_html !== undefined) gqlInput.descriptionHtml = productData.body_html;
      if (productData.vendor) gqlInput.vendor = productData.vendor;
      if (productData.product_type) gqlInput.productType = productData.product_type;
      if (productData.tags) gqlInput.tags = typeof productData.tags === "string" ? productData.tags.split(",").map((t) => t.trim()).filter(Boolean) : productData.tags;
      if (productData.handle) gqlInput.handle = productData.handle;
      if (productData.published !== undefined) gqlInput.status = productData.published ? "ACTIVE" : "DRAFT";
      if (productData.options?.length > 0) gqlInput.options = productData.options.map((o) => o.name);
      if (productData.variants?.length > 0) {
        gqlInput.variants = productData.variants.map((v) => {
          const gv = {};
          const opts = [v.option1, v.option2, v.option3].filter(Boolean);
          if (opts.length) gv.options = opts;
          if (v.price !== undefined) gv.price = v.price;
          if (v.sku) gv.sku = v.sku;
          if (v.barcode) gv.barcode = v.barcode;
          if (v.weight !== undefined) gv.weight = v.weight;
          if (v.weight_unit) gv.weightUnit = v.weight_unit.toUpperCase();
          if (v.inventory_policy) gv.inventoryPolicy = v.inventory_policy.toUpperCase();
          if (v.fulfillment_service) gv.fulfillmentService = v.fulfillment_service === "gift_card" ? "MANUAL" : v.fulfillment_service.toUpperCase();
          if (v.inventory_quantity !== undefined && defaultLocationId) {
            gv.inventoryQuantities = [{ availableQuantity: v.inventory_quantity, locationId: defaultLocationId }];
          }
          return gv;
        });
      }
      const mediaInputs = (productData.images || []).map((img) => ({ originalSource: img.src, mediaContentType: "IMAGE" }));

      const gqlRes = await shopifyFetch(`https://${shopDomain}/admin/api/${version}/graphql.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
        body: JSON.stringify({
          query: `mutation ProductCreate($input: ProductInput!) {
            productCreate(input: $input) {
              product { id }
              userErrors { field message }
            }
          }`,
          variables: { input: gqlInput },
        }),
      });
      if (!gqlRes.ok) throw new Error(`HTTP ${gqlRes.status}`);
      const gqlData = await gqlRes.json();
      if (gqlData.errors?.length) {
        console.error(`[importzo] productCreate GraphQL errors for "${product.title}":`, JSON.stringify(gqlData.errors));
        throw new Error(gqlData.errors.map((e) => e.message).join("; "));
      }
      const userErrors = gqlData?.data?.productCreate?.userErrors || [];
      if (userErrors.length) {
        console.error(`[importzo] productCreate userErrors for "${product.title}":`, JSON.stringify(userErrors));
        throw new Error(userErrors.map((e) => e.message).join("; "));
      }
      const created = gqlData?.data?.productCreate?.product;
      if (!created?.id) {
        console.error(`[importzo] productCreate returned no product for "${product.title}". Response:`, JSON.stringify(gqlData));
        throw new Error("Product creation failed: API returned no product data");
      }
      const productGid = created.id;
      const numericId = created.id.split("/").pop();

      // Attach images via productCreateMedia (media param removed from productCreate in 2025-01+)
      if (mediaInputs.length > 0) {
        try {
          const imgRes = await shopifyFetch(`https://${shopDomain}/admin/api/${version}/graphql.json`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
            body: JSON.stringify({
              query: `mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
                productCreateMedia(productId: $productId, media: $media) {
                  media { ... on MediaImage { id } }
                  mediaUserErrors { field message }
                }
              }`,
              variables: { productId: productGid, media: mediaInputs },
            }),
          });
          const imgData = await imgRes.json();
          const imgErrors = imgData?.data?.productCreateMedia?.mediaUserErrors || [];
          if (imgErrors.length) {
            warnings.push(`Image issues: ${imgErrors.map((e) => e.message).join("; ")}`);
          }
        } catch { /* non-fatal — product was created, images failed */ }
      }
      let videoNote = "";

      // Attach videos via GraphQL productCreateMedia
      if (product.videos && product.videos.length > 0) {
        const validVideos = product.videos.filter(
          (url) => url && url.trim() && /^https?:\/\//i.test(url.trim()),
        );
        if (validVideos.length > 0) {
          // Classify each URL by source
          const shopifyCdn = [];
          const externalEmbed = []; // YouTube / Vimeo
          const unsupported = [];

          for (const raw of validVideos) {
            const url = raw.trim();
            if (/cdn\.shopify\.com/i.test(url)) {
              shopifyCdn.push(url);
            } else if (
              /youtu\.?be(\.com)?/i.test(url) ||
              /vimeo\.com/i.test(url)
            ) {
              externalEmbed.push(url);
            } else {
              unsupported.push(url);
            }
          }

          const videoNotes = [];

          // Helper: call productCreateMedia
          const attachMedia = async (mediaInput) => {
            const gqlRes = await shopifyFetch(
              `https://${shopDomain}/admin/api/${version}/graphql.json`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  "X-Shopify-Access-Token": accessToken,
                },
                body: JSON.stringify({
                  query: `mutation productCreateMedia($media: [CreateMediaInput!]!, $productId: ID!) {
                    productCreateMedia(media: $media, productId: $productId) {
                      media {
                        ... on Video { id status }
                        ... on ExternalVideo { id }
                      }
                      mediaUserErrors { field message }
                    }
                  }`,
                  variables: { productId: productGid, media: mediaInput },
                }),
              },
            );
            return gqlRes.json();
          };

          // 1. Shopify-hosted videos → mediaContentType: VIDEO
          if (shopifyCdn.length > 0) {
            try {
              const input = shopifyCdn.map((url) => ({
                originalSource: url,
                mediaContentType: "VIDEO",
              }));
              const res = await attachMedia(input);
              const errs = res?.data?.productCreateMedia?.mediaUserErrors;
              if (errs && errs.length > 0) {
                videoNotes.push(
                  "Note: Videos must be added manually via Shopify Media Manager",
                );
              } else {
                videoNotes.push(
                  `${shopifyCdn.length} video${shopifyCdn.length > 1 ? "s" : ""} added successfully`,
                );
              }
            } catch {
              videoNotes.push("Note: Videos must be added manually via Shopify Media Manager");
            }
          }

          // 2. YouTube / Vimeo → mediaContentType: EXTERNAL_VIDEO
          if (externalEmbed.length > 0) {
            try {
              const input = externalEmbed.map((url) => ({
                originalSource: url,
                mediaContentType: "EXTERNAL_VIDEO",
              }));
              const res = await attachMedia(input);
              const errs = res?.data?.productCreateMedia?.mediaUserErrors;
              if (errs && errs.length > 0) {
                videoNotes.push(
                  "Note: Videos must be added manually via Shopify Media Manager",
                );
              } else {
                videoNotes.push(
                  `${externalEmbed.length} external video${externalEmbed.length > 1 ? "s" : ""} added successfully`,
                );
              }
            } catch {
              videoNotes.push("Note: Videos must be added manually via Shopify Media Manager");
            }
          }

          // 3. Unsupported (random .mp4, etc.)
          if (unsupported.length > 0) {
            videoNotes.push(
              "Note: Videos must be added manually via Shopify Media Manager",
            );
          }

          if (videoNotes.length > 0) {
            videoNote = " (" + videoNotes.join(". ") + ")";
          }
        }
      }

      const warningNote =
        (warnings.length > 0 ? " (" + warnings.join("; ") + ")" : "") +
        videoNote;

      return {
        row: i + 1,
        title: product.title,
        status: "success",
        productId: numericId,
        variantCount: productData.variants?.length || 1,
        videoNote: warningNote,
      };
    } catch (error) {
      return {
        row: i + 1,
        title: product.title,
        status: "error",
        error: error.message,
      };
    }
  }

  for (let i = 0; i < products.length; i += CONCURRENCY) {
    const slice = products.slice(i, i + CONCURRENCY);
    const sliceResults = await Promise.all(slice.map((product, idx) => processProduct(product, i + idx)));
    for (const r of sliceResults) {
      results.push(r);
      if (r.status === "success") successCount++; else errorCount++;
    }
  }

  const status =
    errorCount === 0
      ? "completed"
      : successCount === 0
        ? "failed"
        : "completed_with_errors";

  await prisma.importJob.create({
    data: {
      shop: session.shop,
      fileName: fileName || "import.csv",
      totalRows: products.length,
      successCount,
      errorCount,
      status,
      results: JSON.stringify(results),
    },
  });

  return { results, successCount, errorCount, status };
};

// ═══════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════
const STEP_UPLOAD = 0;
const STEP_MAP = 1;
const STEP_PREVIEW = 2;
const STEP_IMPORT = 3;

// ═══════════════════════════════════════════════════════════════════
// Component
// ═══════════════════════════════════════════════════════════════════
export default function ImportPage() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();
  const fileInputRef = useRef(null);

  const [step, setStep] = useState(STEP_UPLOAD);
  const [fileName, setFileName] = useState("");
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [csvRows, setCsvRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [confidence, setConfidence] = useState({});
  const [confirmed, setConfirmed] = useState(new Set());
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [variantsDetected, setVariantsDetected] = useState(false);
  const [errorsExpanded, setErrorsExpanded] = useState(false);

  const isImporting =
    ["loading", "submitting"].includes(fetcher.state) &&
    fetcher.formMethod === "POST";

  useEffect(() => {
    if (fetcher.data?.results) {
      setStep(STEP_IMPORT);
      if (fetcher.data.errorCount > 0) {
        setErrorsExpanded(true);
      }
      if (fetcher.data.status === "completed") {
        shopify.toast.show(
          `Successfully imported ${fetcher.data.successCount} products`,
        );
      } else if (fetcher.data.status === "completed_with_errors") {
        shopify.toast.show(
          `Imported ${fetcher.data.successCount} products with ${fetcher.data.errorCount} errors`,
          { isError: true },
        );
      } else {
        shopify.toast.show("Import failed", { isError: true });
      }
    }
  }, [fetcher.data, shopify]);

  const handleFile = useCallback(
    (file) => {
      if (!file || !file.name.endsWith(".csv")) {
        shopify.toast.show("Please upload a CSV file", { isError: true });
        return;
      }
      setFileName(file.name);
      const reader = new FileReader();
      reader.onload = (e) => {
        const text = e.target.result;
        const rows = parseCSV(text);
        if (rows.length < 2) {
          shopify.toast.show(
            "CSV must have a header row and at least one data row",
            { isError: true },
          );
          return;
        }
        const headers = rows[0];
        const dataRows = rows
          .slice(1)
          .filter((r) => r.some((cell) => cell.trim()));
        setCsvHeaders(headers);
        setCsvRows(dataRows);

        const { mapping: detectedMapping, confidence: detectedConfidence } = autoDetectMapping(headers, dataRows);
        setMapping(detectedMapping);
        setConfidence(detectedConfidence);

        const hasVariants = Object.values(detectedMapping).some(
          (f) => f.startsWith("option") || f === "handle",
        );
        setVariantsDetected(hasVariants);

        // Count how many image columns were auto-detected
        const imgCount = Object.values(detectedMapping).filter(
          (f) => f === "image_src",
        ).length;
        const msgs = [];
        if (hasVariants) msgs.push("Variants detected");
        if (imgCount > 1) msgs.push(`${imgCount} image columns found`);
        if (msgs.length > 0) {
          shopify.toast.show(msgs.join(" · ") + ". Auto-mapped.");
        }

        setStep(STEP_MAP);
      };
      reader.readAsText(file);
    },
    [shopify],
  );

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      handleFile(e.dataTransfer.files[0]);
    },
    [handleFile],
  );

  const handleMappingChange = useCallback((colIndex, value) => {
    setMapping((prev) => ({ ...prev, [colIndex]: value }));
    setConfidence((prev) => ({ ...prev, [colIndex]: value ? 100 : 0 }));
    setConfirmed((prev) => { const next = new Set(prev); if (value) next.add(colIndex); else next.delete(colIndex); return next; });
  }, []);

  // ── Group rows into products with variants ──────────────────────
  const getGroupedProducts = useCallback(() => {
    // Find all column indices for multi-map fields
    const imageColIndices = Object.entries(mapping)
      .filter(([, f]) => f === "image_src")
      .map(([idx]) => parseInt(idx));
    const videoColIndices = Object.entries(mapping)
      .filter(([, f]) => f === "video_src")
      .map(([idx]) => parseInt(idx));

    const mappedRows = csvRows.map((row) => {
      const obj = {};
      Object.entries(mapping).forEach(([colIndex, field]) => {
        if (
          field &&
          field !== "image_src" &&
          field !== "video_src" &&
          row[colIndex] !== undefined
        ) {
          obj[field] = (row[colIndex] || "").trim();
        }
      });

      // Collect all image URLs from every image-mapped column
      const images = [];
      imageColIndices.forEach((idx) => {
        if (row[idx]) {
          row[idx]
            .split(",")
            .map((u) => u.trim())
            .filter(Boolean)
            .forEach((url) => {
              if (!images.includes(url)) images.push(url);
            });
        }
      });
      obj._images = images;

      // Collect all video URLs from every video-mapped column
      const videos = [];
      videoColIndices.forEach((idx) => {
        if (row[idx]) {
          row[idx]
            .split(",")
            .map((u) => u.trim())
            .filter(Boolean)
            .forEach((url) => {
              if (!videos.includes(url)) videos.push(url);
            });
        }
      });
      obj._videos = videos;

      return obj;
    });

    // Auto-derive option names from CSV column headers
    const deriveOptionName = (optValueField) => {
      const nameField = optValueField.replace("_value", "_name");
      if (Object.values(mapping).includes(nameField)) return null;
      const colEntry = Object.entries(mapping).find(
        ([, f]) => f === optValueField,
      );
      if (!colEntry) return null;
      const header = csvHeaders[parseInt(colEntry[0])];
      if (!header) return null;
      const norm = header.toLowerCase().replace(/[^a-z0-9]/g, "");
      if (
        norm.includes("option") &&
        (norm.includes("value") || norm.includes("val"))
      )
        return null;
      if (/^option\d$/.test(norm)) return null;
      return header;
    };

    const autoOpt1Name = deriveOptionName("option1_value");
    const autoOpt2Name = deriveOptionName("option2_value");
    const autoOpt3Name = deriveOptionName("option3_value");

    const hasHandle = Object.values(mapping).includes("handle");
    const hasOptionFields = Object.values(mapping).some((f) =>
      f.startsWith("option"),
    );

    // ── No grouping needed — each row is one product ──
    if (!hasHandle && !hasOptionFields) {
      return mappedRows.map((row) => {
        const product = {};
        [
          "title", "body_html", "vendor", "product_type",
          "tags", "handle", "published",
        ].forEach((f) => {
          if (row[f]) product[f] = row[f];
        });

        const variant = {};
        if (row.price) variant.price = row.price;
        if (row.sku) variant.sku = row.sku;
        if (row.barcode) variant.barcode = row.barcode;
        if (row.inventory_quantity)
          variant.inventory_quantity = row.inventory_quantity;
        if (row.weight) variant.weight = row.weight;
        if (row.weight_unit) variant.weight_unit = row.weight_unit;
        if (row.variant_inventory_policy)
          variant.inventory_policy = row.variant_inventory_policy;
        if (row.variant_fulfillment_service)
          variant.fulfillment_service = row.variant_fulfillment_service;
        if (Object.keys(variant).length > 0) {
          product.variants = [variant];
        }

        if (row._images.length > 0) product.images = row._images;
        if (row._videos.length > 0) product.videos = row._videos;

        return product;
      });
    }

    // ── Group by handle or title (with merged-cell support) ──
    const grouped = {};
    const order = [];
    let lastKey = null;

    mappedRows.forEach((row) => {
      let key = row.handle || row.title;
      if (!key) {
        // Empty handle + title = continuation of previous product (merged cells)
        key = lastKey || "untitled";
      } else {
        lastKey = key;
      }

      if (!grouped[key]) {
        grouped[key] = {
          title: row.title || "",
          body_html: row.body_html || "",
          vendor: row.vendor || "",
          product_type: row.product_type || "",
          tags: row.tags || "",
          handle: row.handle || "",
          published: row.published || "",
          option1_name: row.option1_name || autoOpt1Name || "",
          option2_name: row.option2_name || autoOpt2Name || "",
          option3_name: row.option3_name || autoOpt3Name || "",
          variants: [],
          images: [],
          videos: [],
        };
        order.push(key);
      }

      const g = grouped[key];

      // Fill product fields from first row that has them
      if (row.title && !g.title) g.title = row.title;
      if (row.body_html && !g.body_html) g.body_html = row.body_html;
      if (row.vendor && !g.vendor) g.vendor = row.vendor;
      if (row.product_type && !g.product_type)
        g.product_type = row.product_type;
      if (row.tags && !g.tags) g.tags = row.tags;
      if (row.option1_name && !g.option1_name)
        g.option1_name = row.option1_name;
      if (row.option2_name && !g.option2_name)
        g.option2_name = row.option2_name;
      if (row.option3_name && !g.option3_name)
        g.option3_name = row.option3_name;

      // Build variant
      const variant = {};
      if (row.option1_value) variant.option1 = row.option1_value;
      if (row.option2_value) variant.option2 = row.option2_value;
      if (row.option3_value) variant.option3 = row.option3_value;
      if (row.price) variant.price = row.price;
      if (row.sku) variant.sku = row.sku;
      if (row.barcode) variant.barcode = row.barcode;
      if (row.inventory_quantity)
        variant.inventory_quantity = row.inventory_quantity;
      if (row.weight) variant.weight = row.weight;
      if (row.weight_unit) variant.weight_unit = row.weight_unit;
      if (row.variant_inventory_policy)
        variant.inventory_policy = row.variant_inventory_policy;
      if (row.variant_fulfillment_service)
        variant.fulfillment_service = row.variant_fulfillment_service;
      if (Object.keys(variant).length > 0) {
        g.variants.push(variant);
      }

      // Collect images (deduplicated)
      row._images.forEach((url) => {
        if (!g.images.includes(url)) g.images.push(url);
      });

      // Collect videos (deduplicated)
      row._videos.forEach((url) => {
        if (!g.videos.includes(url)) g.videos.push(url);
      });
    });

    return order.map((key) => grouped[key]);
  }, [csvRows, mapping, csvHeaders]);

  const hasTitleMapped = Object.values(mapping).includes("title");

  const handleImport = useCallback(() => {
    const products = getGroupedProducts();
    const formData = new FormData();
    formData.append("products", JSON.stringify(products));
    formData.append("fileName", fileName);
    fetcher.submit(formData, { method: "POST" });
  }, [getGroupedProducts, fileName, fetcher]);

  const resetImport = useCallback(() => {
    setStep(STEP_UPLOAD);
    setFileName("");
    setCsvHeaders([]);
    setCsvRows([]);
    setMapping({});
    setConfidence({});
    setConfirmed(new Set());
    setShowAdvanced(false);
    setVariantsDetected(false);
    setErrorsExpanded(false);
  }, []);

  const steps = ["Upload CSV", "Map Columns", "Preview", "Import"];
  const groupedProducts = step >= STEP_PREVIEW ? getGroupedProducts() : [];
  const hasMediaMapping = Object.values(mapping).some(
    (f) => f === "image_src" || f === "video_src",
  );
  const totalVariants = groupedProducts.reduce(
    (sum, p) => sum + (p.variants?.length || 0),
    0,
  );

  // ── Theme helpers ──
  const primary = "#17320A";

  return (
    <s-page
      heading="Product Importer"
      subtitle={steps[step]}
      backAction={JSON.stringify({ content: "Dashboard", url: "/app" })}
    >
      <div className="space-y-6 animate-fade-in">
        {/* ── Brand Logo ── */}
        <div className="flex items-center gap-2.5">
          <img
            src="/logo.png"
            alt="Importzo"
            style={{ height: 40, width: "auto", objectFit: "contain" }}
          />
          <span
            style={{
              fontSize: 18,
              fontWeight: 600,
              color: "#17320A",
              fontFamily: "'ImportzoFont', sans-serif",
            }}
          >
            Product Importer
          </span>
        </div>

        {/* ── Step Indicator ── */}
        <div className="px-1 pb-2">
          <div className="flex items-center justify-between max-w-xl mx-auto">
            {steps.map((label, i) => (
              <div
                key={label}
                className="flex items-center flex-1 last:flex-initial"
              >
                <div className="flex flex-col items-center gap-1.5">
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      minWidth: 36,
                      minHeight: 36,
                      borderRadius: "50%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: 14,
                      fontWeight: 600,
                      ...(i < step
                        ? {
                            background: primary,
                            color: "white",
                            boxShadow:
                              "0 4px 12px rgba(23, 50, 10, 0.3)",
                          }
                        : i === step
                          ? {
                              background: primary,
                              color: "white",
                              boxShadow:
                                "0 4px 12px rgba(23, 50, 10, 0.3)",
                            }
                          : {
                              background: "#E5E7EB",
                              color: "#6b7280",
                            }),
                    }}
                  >
                    {i < step ? (
                      <svg
                        width="16"
                        height="16"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={3}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M5 13l4 4L19 7"
                        />
                      </svg>
                    ) : (
                      i + 1
                    )}
                  </div>
                  <span
                    className={`text-xs font-medium hidden sm:block ${
                      i === step ? "text-gray-900" : "text-gray-400"
                    }`}
                  >
                    {label}
                  </span>
                </div>
                {i < steps.length - 1 && (
                  <div
                    style={{
                      flex: 1,
                      height: 2,
                      marginLeft: 12,
                      marginRight: 12,
                      borderRadius: 1,
                      background: i < step ? primary : "#e5e7eb",
                      transition: "background 0.5s",
                    }}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* ═══════════════ STEP 1: UPLOAD ═══════════════ */}
        {step === STEP_UPLOAD && (
          <div className="animate-fade-in">
            <div className="bg-white rounded-xl border border-gray-200 p-6 sm:p-8 shadow-sm">
              <h2 className="text-lg font-semibold text-gray-900 mb-6">
                Upload your CSV file
              </h2>
              <div
                role="button"
                tabIndex={0}
                className={`border-2 border-dashed rounded-xl p-8 sm:p-12 text-center cursor-pointer transition-all duration-200 ${
                  dragOver
                    ? "border-green-800 bg-green-50/50"
                    : "border-gray-300 hover:border-gray-400 hover:bg-gray-50/50"
                }`}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInputRef.current?.click(); } }}
              >
                <div className="flex flex-col items-center gap-4">
                  <div
                    style={{ width: 64, height: 64, borderRadius: "50%" }}
                    className={`flex items-center justify-center transition-colors ${
                      dragOver ? "bg-green-100" : "bg-gray-100"
                    }`}
                  >
                    <svg
                      width="32"
                      height="32"
                      className={dragOver ? "text-green-800" : "text-gray-400"}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
                      />
                    </svg>
                  </div>
                  <div>
                    <p className="text-base font-medium text-gray-700">
                      Drag and drop your CSV file here
                    </p>
                    <p className="text-sm text-gray-500 mt-1">
                      or click to browse files
                    </p>
                  </div>
                  <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-gray-100 text-gray-600">
                    .csv files only
                  </span>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files[0];
                    if (file) handleFile(file);
                  }}
                />
              </div>
              <p className="text-sm text-gray-500 mt-4 leading-relaxed">
                Your CSV should include a header row. Columns are auto-mapped
                to Shopify fields including Title, Price, SKU, Variants
                (Size/Color/Material), unlimited Image columns,
                Video URLs (YouTube/Vimeo), and more. Supports comma,
                semicolon, and tab delimiters.
              </p>

              {/* Alternative file sources */}
              <div className="mt-6 pt-5 border-t border-gray-100">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">Or import from</p>
                <FileSourcePicker onFileSelected={handleFile} accept=".csv" />
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════ STEP 2: MAP COLUMNS ═══════════════ */}
        {step === STEP_MAP && (
          <div className="animate-fade-in space-y-4">
            {variantsDetected && (
              <div
                className="rounded-lg px-4 py-3 flex items-center gap-3"
                style={{
                  background: "rgba(23, 50, 10, 0.08)",
                  border: "1px solid rgba(23, 50, 10, 0.25)",
                }}
              >
                <svg
                  className="w-5 h-5 flex-shrink-0"
                  style={{ color: primary }}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
                <span className="text-sm font-medium" style={{ color: "#065f46" }}>
                  Variants detected &mdash; rows with the same Handle/Title
                  will be grouped as one product with multiple variants.
                </span>
              </div>
            )}

            {!hasTitleMapped && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 flex items-center gap-3">
                <svg
                  className="w-5 h-5 text-amber-500 flex-shrink-0"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
                  />
                </svg>
                <span className="text-sm font-medium text-amber-800">
                  Please map at least the Title column to proceed.
                </span>
              </div>
            )}

            {/* AI Smart Summary */}
            {(() => {
              const { items, variant } = generateMappingSummary(csvHeaders, mapping, confidence, confirmed, ["title"]);
              return <AISummary title="Smart Summary" items={items} variant={variant} />;
            })()}

            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100">
                <h2 className="text-lg font-semibold text-gray-900">
                  Map CSV Columns
                </h2>
                <p className="text-sm text-gray-500 mt-1">
                  Detected {csvRows.length} rows in{" "}
                  <span className="font-medium text-gray-700">{fileName}</span>.
                  Review and adjust mappings below.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-50/80">
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">CSV Column</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Shopify Field</th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {csvHeaders.map((header, i) => {
                      const conf = confidence[i] || 0;
                      const level = confidenceLevel(conf);
                      const isMapped = !!mapping[i];
                      const isConfirmed = confirmed.has(i);
                      const isRequired = !isMapped && (header.toLowerCase().includes("title"));
                      let statusLabel, statusClasses;
                      if (isConfirmed) { statusLabel = "Confirmed"; statusClasses = "bg-blue-50 text-blue-700 border-blue-200"; }
                      else if (isMapped && level === "high") { statusLabel = "Auto-mapped"; statusClasses = "bg-green-50 text-green-700 border-green-200"; }
                      else if (isMapped && (level === "medium" || level === "low")) { statusLabel = "Needs review"; statusClasses = "bg-amber-50 text-amber-700 border-amber-200"; }
                      else if (isRequired) { statusLabel = "Missing required field"; statusClasses = "bg-red-50 text-red-700 border-red-200"; }
                      else { statusLabel = null; }
                      return (
                        <tr key={i} className="hover:bg-gray-50/50 transition-colors">
                          <td className="px-6 py-3">
                            <span className="text-sm font-medium text-gray-900">{header}</span>
                            <span className="block text-xs text-gray-400 truncate max-w-[180px]">{csvRows[0]?.[i] || ""}</span>
                          </td>
                          <td className="px-6 py-3">
                            <select value={mapping[i] || ""} onChange={(e) => handleMappingChange(i, e.target.value)}
                              className={`w-full max-w-[220px] px-3 py-1.5 text-sm border rounded-lg outline-none transition-all focus:ring-2 focus:ring-green-800/20 ${mapping[i] ? "border-green-800 bg-green-50 text-green-900 font-medium" : "border-gray-300 bg-white text-gray-600"}`}>
                              {SHOPIFY_FIELDS.map((f) => (<option key={f.value} value={f.value}>{f.label}</option>))}
                            </select>
                          </td>
                          <td className="px-6 py-3">
                            {statusLabel ? (
                              <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${statusClasses}`}>{statusLabel}</span>
                            ) : (
                              <span className="text-xs text-gray-400">&mdash;</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Advanced details (expandable) */}
              <div className="border-t border-gray-100">
                <button onClick={() => setShowAdvanced((p) => !p)}
                  className="w-full px-6 py-3 flex items-center justify-between text-left hover:bg-gray-50/50 transition-colors">
                  <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Advanced details</span>
                  <svg className={`w-4 h-4 text-gray-400 transition-transform ${showAdvanced ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                </button>
                {showAdvanced && (
                  <div className="px-6 pb-4">
                    <table className="w-full text-xs">
                      <thead><tr className="text-gray-400">
                        <th className="text-left py-1 font-medium">Column</th>
                        <th className="text-left py-1 font-medium">Mapped To</th>
                        <th className="text-left py-1 font-medium">Confidence</th>
                        <th className="text-left py-1 font-medium">Source</th>
                      </tr></thead>
                      <tbody className="divide-y divide-gray-50">
                        {csvHeaders.map((header, i) => {
                          const conf = confidence[i] || 0;
                          const level = confidenceLevel(conf);
                          const colors = confidenceColor(level);
                          return (
                            <tr key={i}>
                              <td className="py-1.5 text-gray-600">{header}</td>
                              <td className="py-1.5 text-gray-800 font-medium">{mapping[i] ? SHOPIFY_FIELDS.find((f) => f.value === mapping[i])?.label || mapping[i] : "—"}</td>
                              <td className="py-1.5">{mapping[i] ? <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${colors.bg} ${colors.text}`}>{conf}%</span> : "—"}</td>
                              <td className="py-1.5 text-gray-500">{confirmed.has(i) ? "Manual" : mapping[i] ? "Auto" : "—"}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setStep(STEP_UPLOAD)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => setStep(STEP_PREVIEW)}
                disabled={!hasTitleMapped}
                style={
                  hasTitleMapped
                    ? {
                        background: primary,
                        color: "#fff",
                        borderRadius: 8,
                        fontWeight: 600,
                      }
                    : { borderRadius: 8 }
                }
                className={`px-5 py-2 text-sm rounded-lg transition-all ${
                  hasTitleMapped
                    ? "shadow-sm hover:brightness-110 hover:shadow-[0_4px_12px_rgba(13,148,136,0.4)] active:scale-[0.98]"
                    : "bg-gray-200 text-gray-400 cursor-not-allowed"
                }`}
              >
                Preview Products
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════ STEP 3: PREVIEW ═══════════════ */}
        {step === STEP_PREVIEW && !isImporting && (
          <div className="animate-fade-in space-y-4">
            <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">
                    Preview
                  </h2>
                  <p className="text-sm text-gray-500 mt-0.5">
                    {groupedProducts.length} product
                    {groupedProducts.length !== 1 ? "s" : ""} ready to import
                    {variantsDetected &&
                      totalVariants > 0 &&
                      ` \u00b7 ${totalVariants} variant${totalVariants !== 1 ? "s" : ""} detected`}
                  </p>
                </div>
                <span
                  className="inline-flex items-center self-start px-3 py-1 rounded-full text-xs font-medium"
                  style={{
                    background: "rgba(13, 148, 136, 0.1)",
                    color: "#0D9488",
                  }}
                >
                  {csvRows.length} total rows
                </span>
              </div>
              <div className="overflow-auto max-h-[500px]">
                <table className="w-full">
                  <thead>
                    <tr className="bg-gray-50/80 sticky top-0 z-10">
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        #
                      </th>
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        Product
                      </th>
                      {variantsDetected && (
                        <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                          Variants
                        </th>
                      )}
                      {hasMediaMapping && (
                        <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                          Media
                        </th>
                      )}
                      <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        Details
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {groupedProducts.slice(0, 50).map((product, i) => (
                      <tr
                        key={i}
                        className="hover:bg-gray-50/50 transition-colors"
                      >
                        <td className="px-6 py-3 text-sm text-gray-400 font-mono">
                          {i + 1}
                        </td>
                        <td className="px-6 py-3">
                          <p className="text-sm font-medium text-gray-900">
                            {product.title || "Untitled"}
                          </p>
                          {product.vendor && (
                            <p className="text-xs text-gray-500 mt-0.5">
                              {product.vendor}
                            </p>
                          )}
                        </td>
                        {variantsDetected && (
                          <td className="px-6 py-3">
                            {product.variants &&
                            product.variants.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {product.variants
                                  .slice(0, 3)
                                  .map((v, vi) => (
                                    <span
                                      key={vi}
                                      className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-700"
                                    >
                                      {[v.option1, v.option2, v.option3]
                                        .filter(Boolean)
                                        .join(" / ") ||
                                        v.sku ||
                                        `Variant ${vi + 1}`}
                                    </span>
                                  ))}
                                {product.variants.length > 3 && (
                                  <span className="text-xs text-gray-400 self-center">
                                    +{product.variants.length - 3} more
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-xs text-gray-400">
                                Single variant
                              </span>
                            )}
                          </td>
                        )}
                        {hasMediaMapping && (
                          <td className="px-6 py-3">
                            <div className="flex items-center gap-2">
                              {product.images &&
                              product.images.length > 0 ? (
                                <div className="flex gap-1.5 items-center">
                                  {product.images
                                    .slice(0, 3)
                                    .map((src, ii) => (
                                      <img
                                        key={ii}
                                        src={src}
                                        alt=""
                                        className="w-10 h-10 rounded-lg object-cover border border-gray-200 bg-gray-50"
                                        onError={(e) => {
                                          e.target.style.display = "none";
                                        }}
                                      />
                                    ))}
                                  {product.images.length > 3 && (
                                    <span className="text-xs text-gray-400 ml-1">
                                      +{product.images.length - 3}
                                    </span>
                                  )}
                                  <span
                                    className="inline-flex px-1.5 py-0.5 rounded text-xs font-medium ml-1"
                                    style={{
                                      background:
                                        product.images.length > 250
                                          ? "rgba(239,68,68,0.1)"
                                          : "rgba(13,148,136,0.1)",
                                      color:
                                        product.images.length > 250
                                          ? "#b91c1c"
                                          : "#0D9488",
                                    }}
                                  >
                                    {product.images.length} image{product.images.length !== 1 ? "s" : ""}
                                    {product.images.length > 250 ? " (max 250)" : ""}
                                  </span>
                                </div>
                              ) : null}
                              {product.videos &&
                                product.videos.length > 0 && (
                                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-purple-50 text-purple-700">
                                    <svg
                                      width="12"
                                      height="12"
                                      viewBox="0 0 24 24"
                                      fill="currentColor"
                                    >
                                      <path d="M8 5v14l11-7z" />
                                    </svg>
                                    {product.videos.length}
                                  </span>
                                )}
                              {(!product.images ||
                                product.images.length === 0) &&
                                (!product.videos ||
                                  product.videos.length === 0) && (
                                  <span className="text-xs text-gray-400">
                                    &mdash;
                                  </span>
                                )}
                            </div>
                          </td>
                        )}
                        <td className="px-6 py-3 text-xs text-gray-500 max-w-[250px]">
                          {[
                            product.product_type &&
                              `Type: ${product.product_type}`,
                            product.tags && `Tags: ${product.tags}`,
                            product.variants?.[0]?.price &&
                              `$${product.variants[0].price}`,
                          ]
                            .filter(Boolean)
                            .join(" \u00b7 ") || "\u2014"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {groupedProducts.length > 50 && (
                <div className="px-6 py-3 border-t border-gray-100 bg-gray-50/50">
                  <p className="text-xs text-gray-500">
                    Showing first 50 of {groupedProducts.length} products
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={() => setStep(STEP_MAP)}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Back
              </button>
              <button
                onClick={handleImport}
                style={{
                  background: primary,
                  color: "#fff",
                  borderRadius: 8,
                  fontWeight: 600,
                }}
                className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 hover:shadow-[0_4px_12px_rgba(13,148,136,0.4)] transition-all active:scale-[0.98]"
              >
                Import {groupedProducts.length} Product
                {groupedProducts.length !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════ LOADING STATE ═══════════════ */}
        {isImporting && (
          <div className="animate-fade-in">
            <div className="bg-white rounded-xl border border-gray-200 p-8 sm:p-10 shadow-sm">
              <div className="flex flex-col items-center gap-6 max-w-md mx-auto">
                <div
                  style={{ width: 64, height: 64, borderRadius: "50%" }}
                  className="flex items-center justify-center bg-teal-50"
                >
                  <svg
                    width="32"
                    height="32"
                    className="animate-spin"
                    style={{ color: primary }}
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                </div>
                <div className="text-center">
                  <h3 className="text-lg font-semibold text-gray-900">
                    Importing products...
                  </h3>
                  <p className="text-sm text-gray-500 mt-2">
                    Please wait while your products are being created. Do not
                    close this page.
                  </p>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="h-full rounded-full animate-progress"
                    style={{ width: "100%", background: primary }}
                  />
                </div>
                <div className="w-full space-y-3 mt-2">
                  {[1, 2, 3].map((n) => (
                    <div key={n} className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg animate-shimmer flex-shrink-0" />
                      <div className="flex-1 space-y-2">
                        <div className="h-3 animate-shimmer rounded w-3/4" />
                        <div className="h-2.5 animate-shimmer rounded w-1/2" />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ═══════════════ STEP 4: RESULTS ═══════════════ */}
        {step === STEP_IMPORT && fetcher.data?.results && (
          <div className="animate-fade-in space-y-4">
            {/* Summary Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="bg-white rounded-xl border border-green-200 p-6 shadow-sm">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 rounded-full bg-green-50 flex items-center justify-center flex-shrink-0">
                    <svg
                      className="w-6 h-6 text-green-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                      />
                    </svg>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-gray-900">
                      {fetcher.data.successCount}
                    </p>
                    <p className="text-sm text-green-600 font-medium">
                      Imported successfully
                    </p>
                  </div>
                </div>
              </div>
              {fetcher.data.errorCount > 0 && (
                <div className="bg-white rounded-xl border border-red-200 p-6 shadow-sm">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
                      <svg
                        className="w-6 h-6 text-red-500"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={2}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                        />
                      </svg>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-gray-900">
                        {fetcher.data.errorCount}
                      </p>
                      <p className="text-sm text-red-600 font-medium">
                        Failed to import
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* AI Result Summary */}
            {(() => {
              const s = generateImportResultSummary(fetcher.data.successCount, fetcher.data.errorCount, csvRows.length, "product");
              return <AISummary icon="📊" title="Import Summary" items={s.items} variant={s.variant} />;
            })()}

            {/* Error Details */}
            {fetcher.data.errorCount > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <button
                  onClick={() => setErrorsExpanded(!errorsExpanded)}
                  className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full bg-red-500" />
                    <span className="text-sm font-semibold text-gray-900">
                      Error Details ({fetcher.data.errorCount})
                    </span>
                  </div>
                  <svg
                    className={`w-5 h-5 text-gray-400 transition-transform duration-200 ${
                      errorsExpanded ? "rotate-180" : ""
                    }`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M19 9l-7 7-7-7"
                    />
                  </svg>
                </button>
                {errorsExpanded && (
                  <div className="border-t border-gray-100">
                    <div className="overflow-auto max-h-[300px]">
                      <table className="w-full">
                        <thead>
                          <tr className="bg-red-50/50">
                            <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">
                              #
                            </th>
                            <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">
                              Product
                            </th>
                            <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">
                              Error
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-100">
                          {fetcher.data.results
                            .filter((r) => r.status === "error")
                            .map((result) => (
                              <tr key={result.row}>
                                <td className="px-6 py-2.5 text-sm text-gray-500">
                                  {result.row}
                                </td>
                                <td className="px-6 py-2.5 text-sm font-medium text-gray-900">
                                  {result.title || "\u2014"}
                                </td>
                                <td className="px-6 py-2.5 text-sm text-red-600 max-w-[350px]">
                                  <div className="break-words leading-relaxed">
                                    {(() => {
                                      try {
                                        const parsed = JSON.parse(
                                          result.error,
                                        );
                                        if (typeof parsed === "object") {
                                          return Object.entries(parsed).map(
                                            ([key, val]) => (
                                              <div
                                                key={key}
                                                className="mb-0.5"
                                              >
                                                <span className="font-medium text-red-700">
                                                  {key}:
                                                </span>{" "}
                                                {Array.isArray(val)
                                                  ? val.join(", ")
                                                  : String(val)}
                                              </div>
                                            ),
                                          );
                                        }
                                        return result.error;
                                      } catch {
                                        return result.error;
                                      }
                                    })()}
                                  </div>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Success List */}
            {fetcher.data.successCount > 0 && (
              <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100">
                  <h3 className="text-sm font-semibold text-gray-900">
                    Successfully Imported ({fetcher.data.successCount})
                  </h3>
                </div>
                <div className="overflow-auto max-h-[300px]">
                  <table className="w-full">
                    <thead>
                      <tr className="bg-gray-50/80">
                        <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">
                          #
                        </th>
                        <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">
                          Product
                        </th>
                        <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">
                          Product ID
                        </th>
                        <th className="px-6 py-2 text-left text-xs font-semibold text-gray-500">
                          Variants
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {fetcher.data.results
                        .filter((r) => r.status === "success")
                        .map((result) => (
                          <tr
                            key={result.row}
                            className="hover:bg-gray-50/50 transition-colors"
                          >
                            <td className="px-6 py-2.5 text-sm text-gray-500">
                              {result.row}
                            </td>
                            <td className="px-6 py-2.5 text-sm font-medium text-gray-900">
                              {result.title || "\u2014"}
                            </td>
                            <td className="px-6 py-2.5 text-sm text-gray-500 font-mono">
                              {result.productId}
                            </td>
                            <td className="px-6 py-2.5">
                              <span
                                className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium"
                                style={{
                                  background: "rgba(13,148,136,0.1)",
                                  color: "#0D9488",
                                }}
                              >
                                {result.variantCount || 1}
                              </span>
                              {result.videoNote && (
                                <span className="ml-1 text-xs text-amber-600">
                                  {result.videoNote}
                                </span>
                              )}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center gap-3">
              <button
                onClick={resetImport}
                style={{
                  background: primary,
                  color: "#fff",
                  borderRadius: 8,
                  fontWeight: 600,
                }}
                className="px-5 py-2.5 text-sm rounded-lg shadow-sm hover:brightness-110 hover:shadow-[0_4px_12px_rgba(13,148,136,0.4)] transition-all active:scale-[0.98]"
              >
                New Import
              </button>
              <Link
                to="/app"
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                Back to Dashboard
              </Link>
            </div>
          </div>
        )}
      </div>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  return (
    <FriendlyErrorBoundary
      heading="Import Products"
      title="We couldn't load the Product Importer"
      message="Please try again. Your CSV file and store data are untouched."
      error={error}
    />
  );
}
export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
