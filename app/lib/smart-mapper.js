// ═══════════════════════════════════════════════════════════════════
// Smart Column Mapper — AI-powered CSV header detection
//
// Multi-algorithm scoring: exact match, substring, bigram similarity,
// Levenshtein distance, data-type inference from sample rows.
// Supports multilingual aliases (EN, FR, ES, DE, PT).
// ═══════════════════════════════════════════════════════════════════

// ── String similarity algorithms ──

function levenshtein(a, b) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      matrix[i][j] = b[i - 1] === a[j - 1]
        ? matrix[i - 1][j - 1]
        : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

function bigramSimilarity(a, b) {
  if (a.length < 2 || b.length < 2) return 0;
  const setA = new Set();
  const setB = new Set();
  for (let i = 0; i < a.length - 1; i++) setA.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) setB.add(b.slice(i, i + 2));
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / Math.max(setA.size, setB.size);
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Combined similarity: best of multiple algorithms, weighted
function similarity(header, alias) {
  const a = normalize(header);
  const b = normalize(alias);
  if (!a || !b) return 0;
  if (a === b) return 1.0;
  if (a.includes(b) || b.includes(a)) return 0.92;

  const bigram = bigramSimilarity(a, b);
  const maxLen = Math.max(a.length, b.length);
  const lev = 1 - levenshtein(a, b) / maxLen;

  return Math.max(bigram, lev);
}

// ── Data type inference from sample values ──

const DATA_PATTERNS = {
  url: /^https?:\/\//i,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  price: /^\$?\d+([.,]\d{1,2})?$/,
  integer: /^\d+$/,
  decimal: /^\d+[.,]\d+$/,
  boolean: /^(true|false|yes|no|1|0|active|inactive|published|draft)$/i,
  html: /<[a-z][\s\S]*>/i,
  sku_like: /^[A-Z0-9][-A-Z0-9_]{2,}$/i,
  barcode_like: /^\d{8,14}$/,
};

function inferDataType(values) {
  const clean = values.filter((v) => v && v.trim());
  if (clean.length === 0) return "empty";
  const counts = {};
  for (const val of clean) {
    for (const [type, pattern] of Object.entries(DATA_PATTERNS)) {
      if (pattern.test(val.trim())) {
        counts[type] = (counts[type] || 0) + 1;
      }
    }
  }
  let best = "text";
  let bestPct = 0;
  for (const [type, count] of Object.entries(counts)) {
    const pct = count / clean.length;
    if (pct > bestPct) { bestPct = pct; best = type; }
  }
  return bestPct >= 0.5 ? best : "text";
}

// ── Data type boost: extra score when data matches expected type ──

const FIELD_DATA_TYPES = {
  title: ["text"],
  handle: ["text", "sku_like"],
  body_html: ["text", "html"],
  vendor: ["text"],
  product_type: ["text"],
  tags: ["text"],
  published: ["boolean"],
  price: ["price", "decimal"],
  sku: ["sku_like", "text"],
  barcode: ["barcode_like", "integer"],
  inventory_quantity: ["integer"],
  weight: ["decimal", "integer", "price"],
  weight_unit: ["text"],
  image_src: ["url"],
  video_src: ["url"],
  image_url: ["url"],
  quantity: ["integer"],
  location: ["text"],
  collection_type: ["text", "boolean"],
};

// ── Field alias dictionaries (multilingual) ──

export const PRODUCT_ALIASES = {
  title: [
    "title", "name", "productname", "producttitle", "itemname",
    // FR
    "titre", "nom", "nomproduit",
    // ES
    "titulo", "nombre", "nombreproducto",
    // DE
    "titel", "produktname", "bezeichnung",
    // PT
    "titulo", "nomeproduto",
  ],
  handle: [
    "handle", "producthandle", "urlhandle", "slug", "permalink", "seourl",
  ],
  body_html: [
    "description", "bodyhtml", "body", "desc", "htmlbody", "productdescription",
    "longdescription", "details", "content",
    "beschreibung", "descripcion", "descricao",
  ],
  vendor: [
    "vendor", "brand", "manufacturer", "supplier", "maker",
    "marque", "marca", "hersteller", "fabricante",
  ],
  product_type: [
    "producttype", "type", "category", "productcategory",
    "categorie", "categoria", "kategorie",
  ],
  tags: [
    "tags", "tag", "labels", "keywords",
    "etiquettes", "etiquetas", "schlagworter",
  ],
  published: [
    "published", "status", "active", "visible", "isonline", "live",
    "publie", "publicado", "veroffentlicht",
  ],
  option1_name: ["option1name", "variantoptionname1"],
  option1_value: ["option1value", "variantoptionvalue1", "option1"],
  option2_name: ["option2name", "variantoptionname2"],
  option2_value: ["option2value", "variantoptionvalue2", "option2"],
  option3_name: ["option3name", "variantoptionname3"],
  option3_value: ["option3value", "variantoptionvalue3", "option3"],
  price: [
    "price", "variantprice", "cost", "amount", "unitprice", "saleprice",
    "prix", "precio", "preis", "preco",
  ],
  sku: [
    "sku", "stockkeepingunit", "itemno", "itemnumber", "partnumber", "variantsku",
    "articleno", "articlenumber", "reference", "ref",
    "referencia", "artikelnummer",
  ],
  barcode: [
    "barcode", "upc", "ean", "gtin", "isbn", "variantbarcode",
    "codebarre", "codigodebarras", "strichcode",
  ],
  inventory_quantity: [
    "inventory", "inventoryquantity", "qty", "quantity",
    "stock", "stockqty", "variantinventoryqty", "onhand", "available",
    "quantite", "cantidad", "menge", "quantidade",
  ],
  weight: [
    "weight", "productweight", "variantweight",
    "poids", "peso", "gewicht",
  ],
  weight_unit: ["weightunit", "variantweightunit"],
  image_src: [
    "image", "imagesrc", "imageurl", "img", "photo", "picture", "thumbnail",
    "productimage", "mainimage", "imagemain",
  ],
  video_src: [
    "video", "videourl", "videosrc", "youtube", "vimeo",
  ],
  variant_inventory_policy: ["variantinventorypolicy", "inventorypolicy"],
  variant_fulfillment_service: ["variantfulfillmentservice", "fulfillmentservice"],
};

export const COLLECTION_ALIASES = {
  title: [
    "title", "name", "collectionname", "collectiontitle",
    "titre", "nom", "titulo", "nombre",
  ],
  body_html: [
    "bodyhtml", "body", "description", "desc", "html", "content",
    "beschreibung", "descripcion",
  ],
  image_url: [
    "image", "imageurl", "imagesrc", "img", "photo", "thumbnail",
  ],
  sort_order: ["sortorder", "sort", "order", "ordering"],
  published: ["published", "status", "active", "visible"],
  collection_type: ["type", "collectiontype", "kind"],
  rules_column: ["rules", "smartrules", "conditions", "rule"],
};

export const INVENTORY_ALIASES = {
  sku: [
    "sku", "stockkeepingunit", "itemno", "itemnumber", "partnumber",
    "variantsku", "productsku", "articleno", "reference",
  ],
  location: [
    "location", "locationname", "warehouse", "store",
    "fulfillmentlocation", "depot", "almacen", "lager",
  ],
  quantity: [
    "quantity", "qty", "available", "stock", "inventoryquantity",
    "inventoryqty", "onhand", "stockqty", "count",
    "quantite", "cantidad", "menge",
  ],
};

// ── Smart option detection (Size/Color/Material → option values) ──

const OPTION_KEYWORDS = {
  option1_value: ["size", "dimension", "taille", "talla", "grosse", "tamanho"],
  option2_value: ["color", "colour", "shade", "couleur", "farbe", "cor"],
  option3_value: ["material", "style", "flavor", "flavour", "pattern", "finish", "matiere", "materia"],
};

// ═══════════════════════════════════════════════════════════════════
// Main API: smartMapColumns
//
// Returns: { mapping: { [colIndex]: fieldValue }, confidence: { [colIndex]: 0-100 } }
// ═══════════════════════════════════════════════════════════════════

export function smartMapColumns(headers, dataRows, aliases, options = {}) {
  const { multiMap = [] } = options;
  // multiMap: field names that can be mapped to multiple columns (e.g. "image_src", "video_src")

  const mapping = {};
  const confidence = {};
  const usedFields = new Set();

  // Sample up to 10 data rows for type inference
  const sampleRows = dataRows.slice(0, 10);

  // Score each header against each field
  const scores = []; // [{ colIndex, field, score }]

  headers.forEach((header, colIndex) => {
    const colSamples = sampleRows.map((row) => row[colIndex] || "");
    const dataType = inferDataType(colSamples);

    for (const [field, fieldAliases] of Object.entries(aliases)) {
      let bestAliasScore = 0;
      for (const alias of fieldAliases) {
        const s = similarity(header, alias);
        if (s > bestAliasScore) bestAliasScore = s;
      }

      // Data type boost: if column data matches expected type, add bonus
      const expectedTypes = FIELD_DATA_TYPES[field] || [];
      let typeBoost = 0;
      if (bestAliasScore >= 0.3 && expectedTypes.includes(dataType)) {
        typeBoost = 0.1;
      }
      // Penalize if data type strongly contradicts the field
      if (bestAliasScore >= 0.3 && dataType !== "text" && dataType !== "empty") {
        if (field === "image_src" && dataType !== "url") typeBoost = -0.15;
        if (field === "price" && dataType !== "price" && dataType !== "decimal" && dataType !== "integer") typeBoost = -0.1;
        if (field === "barcode" && dataType !== "barcode_like" && dataType !== "integer") typeBoost = -0.05;
      }

      const finalScore = Math.min(1.0, bestAliasScore + typeBoost);
      if (finalScore >= 0.4) {
        scores.push({ colIndex, field, score: finalScore });
      }
    }
  });

  // Sort by score descending — assign best matches first
  scores.sort((a, b) => b.score - a.score);

  for (const { colIndex, field, score } of scores) {
    if (mapping[colIndex] !== undefined) continue; // column already mapped
    if (!multiMap.includes(field) && usedFields.has(field)) continue; // field already used (single-map)

    mapping[colIndex] = field;
    confidence[colIndex] = Math.round(score * 100);
    if (!multiMap.includes(field)) usedFields.add(field);
  }

  // ── Smart option detection for product aliases ──
  if (aliases === PRODUCT_ALIASES) {
    headers.forEach((header, colIndex) => {
      if (mapping[colIndex] !== undefined) return;
      const norm = normalize(header);
      for (const [optField, keywords] of Object.entries(OPTION_KEYWORDS)) {
        if (usedFields.has(optField)) continue;
        if (keywords.some((kw) => norm.includes(kw))) {
          mapping[colIndex] = optField;
          confidence[colIndex] = 75; // medium confidence for keyword detection
          usedFields.add(optField);
          return;
        }
      }
    });
  }

  // Fill unmapped columns with skip
  headers.forEach((_, index) => {
    if (mapping[index] === undefined) {
      mapping[index] = "";
      confidence[index] = 0;
    }
  });

  return { mapping, confidence };
}

// ═══════════════════════════════════════════════════════════════════
// Confidence badge helpers
// ═══════════════════════════════════════════════════════════════════

export function confidenceLevel(score) {
  if (score >= 85) return "high";
  if (score >= 60) return "medium";
  if (score > 0) return "low";
  return "none";
}

export function confidenceColor(level) {
  switch (level) {
    case "high": return { bg: "bg-green-50", text: "text-green-700", border: "border-green-200" };
    case "medium": return { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" };
    case "low": return { bg: "bg-red-50", text: "text-red-700", border: "border-red-200" };
    default: return { bg: "bg-gray-50", text: "text-gray-400", border: "border-gray-200" };
  }
}
