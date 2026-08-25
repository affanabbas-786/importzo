// ═══════════════════════════════════════════════════════════════════
// Shopify Files referenced BY a theme, as opposed to files that are part
// of the theme.
//
// Theme settings routinely point at store media — `shopify://shop_images/
// hero.jpg`, `/cdn/shop/files/logo.png` — which lives in the destination
// store's Files area, not inside the theme ZIP. Copying the theme without
// copying those leaves a theme whose images all 404.
//
// Extracted from app.transfer.jsx so the theme worker and the route share
// one implementation. These were closure-scoped inside the action, which
// made them unreachable from a background worker that has no request.
// ═══════════════════════════════════════════════════════════════════

/** Shopify's FileCreateInput.contentType, inferred from the extension. */
export function mediaContentTypeFromUrl(url = "") {
  const clean = String(url).split("?")[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|svg|bmp|avif)$/.test(clean)) return "IMAGE";
  if (/\.(mp4|mov|m4v|webm)$/.test(clean)) return "VIDEO";
  if (/\.(glb|usdz)$/.test(clean)) return "MODEL_3D";
  return "FILE";
}

/**
 * The bare filename from either a `shopify://shop_images/...` reference or
 * an ordinary CDN URL. Used as the identity of a file across the two
 * stores — Shopify dedupes uploads by filename, which is what makes
 * re-running the media phase safe on a resume.
 */
export function filenameFromUrlOrRef(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let name = raw;
  if (raw.startsWith("shopify://shop_images/")) {
    name = raw.replace(/^shopify:\/\/shop_images\//, "");
  } else {
    try {
      const u = new URL(raw);
      const parts = u.pathname.split("/").filter(Boolean);
      name = parts[parts.length - 1] || "";
    } catch {
      const parts = raw.split("/").filter(Boolean);
      name = parts[parts.length - 1] || raw;
    }
  }
  try { name = decodeURIComponent(name); } catch { /* keep original */ }
  return name.split("?")[0].split("#")[0];
}

/** Public CDN URLs to try for a file we only know by name. */
export function candidateFileUrls(sourceShop, filename) {
  const encoded = filename.split("/").map(encodeURIComponent).join("/");
  return [
    `https://${sourceShop}/cdn/shop/files/${encoded}`,
    `https://${sourceShop}/cdn/shop/files/${encoded}?v=1`,
  ];
}

/**
 * Scans theme files for references to store media.
 *
 * Only text-ish assets are scanned — reading a binary as UTF-8 to regex it
 * wastes time and can't match anything useful. Results are de-duplicated by
 * filename, since the same logo is typically referenced from a dozen
 * sections.
 */
export function extractThemeFileReferences(files) {
  const refs = new Map();
  const add = (raw) => {
    const name = filenameFromUrlOrRef(raw);
    if (!name || refs.has(name)) return;
    refs.set(name, { filename: name, original: raw });
  };

  for (const file of files) {
    const name = String(file.name || "");
    if (!/(\.json|\.liquid|\.css|\.js|\.scss|\.txt)$/i.test(name)) continue;
    const text = Buffer.isBuffer(file.data) ? file.data.toString("utf8") : String(file.data || "");
    for (const m of text.matchAll(/shopify:\/\/shop_images\/([^"'\\\s,)]+[^"'\\\s,)]*)/g)) add(`shopify://shop_images/${m[1]}`);
    for (const m of text.matchAll(/https?:\/\/[^"'\\\s)]+\/cdn\/shop\/files\/([^"'\\\s)]+)/g)) add(m[0]);
    for (const m of text.matchAll(/https?:\/\/cdn\.shopify\.com\/s\/files\/[^"'\\\s)]*\/files\/([^"'\\\s)]+)/g)) add(m[0]);
  }
  return [...refs.values()];
}

const FILE_CREATE_MUTATION = `#graphql
  mutation fileCreate($files: [FileCreateInput!]!) {
    fileCreate(files: $files) {
      files { id fileStatus alt createdAt ... on GenericFile { url } }
      userErrors { field message code }
    }
  }`;

/**
 * Uploads referenced media to the destination store.
 *
 * `shopifyGraphql` is injected rather than imported so the caller supplies
 * whichever client it already has bound to an API version — the route binds
 * one per request, the worker binds one per job.
 *
 * Deliberately never throws: missing media degrades a theme, it does not
 * break it, and failing the whole transfer over one unreachable image would
 * be the worse outcome. Failures come back as warnings.
 */
export async function createFilesOnTargetFromThemeRefs({ shopifyGraphql, sourceShop, targetShop, targetToken, refs }) {
  if (!refs?.length) return { total: 0, uploaded: 0, warnings: [] };
  const warnings = [];
  let uploaded = 0;

  for (let i = 0; i < refs.length; i += 25) {
    const batch = refs.slice(i, i + 25).map((ref) => {
      const originalSource = ref.original.startsWith("http")
        ? ref.original
        : candidateFileUrls(sourceShop, ref.filename)[0];
      return {
        contentType: mediaContentTypeFromUrl(ref.filename),
        originalSource,
        filename: ref.filename,
        alt: ref.filename.replace(/[-_]+/g, " ").replace(/\.[^.]+$/, "").slice(0, 500),
      };
    });
    try {
      const data = await shopifyGraphql(targetShop, targetToken, FILE_CREATE_MUTATION, { files: batch });
      const errors = data?.fileCreate?.userErrors || [];
      const files = data?.fileCreate?.files || [];
      uploaded += files.length;
      if (errors.length) warnings.push(...errors.map((e) => `${e.message}${e.field ? ` (${e.field.join(".")})` : ""}`));
    } catch (err) {
      warnings.push(`Theme file media batch failed: ${err.message}`);
    }
    if (i + 25 < refs.length) await new Promise((r) => setTimeout(r, 1000));
  }
  return { total: refs.length, uploaded, warnings };
}
