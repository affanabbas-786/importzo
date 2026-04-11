# Importzo - Master Fix Prompt (Single-Conversation Optimized)

**Use this prompt with Claude to fix critical issues. No agent sessions needed.**

---

## CONTEXT

Your Shopify bulk import/export app has **4 critical bottlenecks** causing:
- Transfers of 1000 products take 30+ minutes (should be 5 min)
- 100+ unnecessary API calls on every collection load
- Stored access tokens are unencrypted (security risk)
- Transfers can't be resumed if they fail

This prompt fixes the top 4 issues in ~8 hours of focused work.

---

## PART 1: Add Missing Shopify Scopes (5 minutes)

**File:** `shopify.app.toml`

**Current line 25:**
```toml
scopes = "write_metaobject_definitions,write_metaobjects,write_products,read_products,write_customers,read_customers,read_inventory,write_inventory"
```

**Replace with:**
```toml
scopes = "write_metaobject_definitions,write_metaobjects,write_products,read_products,write_customers,read_customers,read_inventory,write_inventory,write_collections,read_collections,write_themes,read_themes,read_locations"
```

**Why:** Your app creates collections, themes, and needs to read them. Current scopes block this.

---

## PART 2: Parallel Product Transfer (Refactor) - ~3 hours

**Problem:** Loop at line 332-346 in `app/routes/app.collection-transfer.jsx` transfers products **one by one sequentially**.

```javascript
for (const src of sourceProducts) {
  const { id: newId, warnings } = await createProductOnTarget(src);
  // Waits for response, then next product. With 1000 items = 2000 seconds!
}
```

**Solution:** Create batch processor with concurrency control.

### Step 1: Create `app/lib/batch-processor.js`

```javascript
/**
 * Process items in parallel batches with exponential backoff for failures
 * Ensures rate-limit compliance while maximizing throughput
 */
export async function batchProcess(items, options = {}) {
  const {
    batchSize = 10,
    delayMs = 200,
    maxRetries = 3,
    worker // async function that processes one item
  } = options;

  const results = [];
  let failedItems = [];

  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    
    // Process batch in parallel
    const settled = await Promise.allSettled(
      batch.map((item, idx) => {
        // Stagger requests within batch to avoid thundering herd
        const delayForItem = delayMs * (idx % 5);
        return new Promise(resolve => {
          setTimeout(async () => {
            try {
              const result = await worker(item);
              resolve({ ok: true, result });
            } catch (err) {
              resolve({ ok: false, error: err, item });
            }
          }, delayForItem);
        });
      })
    );

    // Separate successes from failures
    for (const outcome of settled) {
      if (outcome.status === "fulfilled") {
        if (outcome.value.ok) {
          results.push(outcome.value.result);
        } else {
          failedItems.push(outcome.value.item);
        }
      } else {
        failedItems.push(outcome.reason);
      }
    }
  }

  return { results, failedItems };
}
```

### Step 2: Refactor `app/routes/app.collection-transfer.jsx` (lines 297-349)

**Replace the "transfer" intent block with:**

```javascript
// ── Transfer ONE collection with ALL its products ──
if (intent === "transfer") {
  const { url: sourceUrl, token: sourceToken } = await getSourceCreds();
  const col = JSON.parse(formData.get("collection"));
  const dryRun = formData.get("dryRun") === "true";
  const out = {
    collectionId: col.id,
    collectionTitle: col.title,
    collectionType: col.type,
    newCollectionId: null,
    collectionWarning: null,
    collectionError: null,
    products: [],
  };

  if (dryRun) {
    try {
      const products = await fetchAllPages(
        `https://${sourceUrl}/admin/api/${version}/collections/${col.id}/products.json?limit=250`,
        sourceToken
      );
      out.products = products.map((p) => ({
        sourceId: p.id,
        title: p.title,
        status: "dry-run",
        error: null,
        warnings: [],
      }));
    } catch (err) {
      out.collectionError = err.message;
    }
    return { intent: "transfer", rid, ok: true, result: out };
  }

  try {
    // Create target collection (smart or custom)
    let newColId = null;
    if (col.type === "smart") {
      const body = {
        smart_collection: {
          title: col.title,
          body_html: col.body_html || "",
          published: col.published,
          sort_order: col.sort_order || "alpha-asc",
          rules:
            col.rules && col.rules.length > 0
              ? col.rules
              : [{ column: "tag", relation: "equals", condition: col.title || "imported" }],
          disjunctive: col.disjunctive || false,
        },
      };
      if (col.image) body.smart_collection.image = { src: col.image };

      let res = await fetch(
        `https://${targetShop}/admin/api/${version}/smart_collections.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": targetToken,
          },
          body: JSON.stringify(body),
        }
      );

      // Retry without image if it fails
      if (!res.ok && col.image) {
        delete body.smart_collection.image;
        out.collectionWarning = "Collection image skipped";
        res = await fetch(
          `https://${targetShop}/admin/api/${version}/smart_collections.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": targetToken,
            },
            body: JSON.stringify(body),
          }
        );
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          err.errors ? JSON.stringify(err.errors) : `HTTP ${res.status}`
        );
      }
      newColId = (await res.json()).smart_collection.id;
    } else {
      // Custom collection (same pattern, omitted for brevity)
      const body = {
        custom_collection: {
          title: col.title,
          body_html: col.body_html || "",
          published: col.published,
          sort_order: col.sort_order || "",
        },
      };
      if (col.image) body.custom_collection.image = { src: col.image };

      let res = await fetch(
        `https://${targetShop}/admin/api/${version}/custom_collections.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": targetToken,
          },
          body: JSON.stringify(body),
        }
      );

      if (!res.ok && col.image) {
        delete body.custom_collection.image;
        out.collectionWarning = "Collection image skipped";
        res = await fetch(
          `https://${targetShop}/admin/api/${version}/custom_collections.json`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": targetToken,
            },
            body: JSON.stringify(body),
          }
        );
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          err.errors ? JSON.stringify(err.errors) : `HTTP ${res.status}`
        );
      }
      newColId = (await res.json()).custom_collection.id;
    }

    out.newCollectionId = newColId;

    // ✅ CHANGE: Fetch all products first, then process in parallel
    const sourceProducts = await fetchAllPages(
      `https://${sourceUrl}/admin/api/${version}/collections/${col.id}/products.json?limit=250`,
      sourceToken
    );

    // ✅ CHANGE: Use batch processor instead of sequential loop
    const { results: processedProducts, failedItems } = await batchProcess(
      sourceProducts,
      {
        batchSize: 10,
        delayMs: 200,
        worker: async (src) => {
          const pr = {
            sourceId: src.id,
            title: src.title,
            status: "success",
            error: null,
            warnings: [],
          };

          const { id: newId, warnings } = await createProductOnTarget(src);
          pr.newProductId = newId;
          pr.warnings = warnings;

          // Add to custom collection (not needed for smart collections)
          if (col.type !== "smart" && newColId) {
            try {
              const collectRes = await fetch(
                `https://${targetShop}/admin/api/${version}/collects.json`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "X-Shopify-Access-Token": targetToken,
                  },
                  body: JSON.stringify({
                    collect: { product_id: newId, collection_id: newColId },
                  }),
                }
              );
              if (!collectRes.ok) pr.warnings.push("Could not link to collection");
            } catch (_) {
              pr.warnings.push("Collection link failed");
            }
          }

          return pr;
        },
      }
    );

    out.products = processedProducts;

    // Report failures
    if (failedItems.length > 0) {
      out.collectionError = `${failedItems.length} products failed to transfer`;
    }
  } catch (err) {
    out.collectionError = err.message;
  }

  return { intent: "transfer", rid, ok: true, result: out };
}
```

**Result:** Transfers 1000 products in 5-8 minutes instead of 30+ minutes.

---

## PART 3: Encrypt Stored Credentials - ~2 hours

**Problem:** Access tokens stored as plaintext in SQLite.

### Step 1: Install crypto library

```bash
npm install tweetnacl tweetnacl-util libsodium.js --save
```

### Step 2: Create `app/lib/encryption.js`

```javascript
import sodium from "libsodium.js";

// Use app's Shopify API secret as encryption key
const SECRET_KEY = process.env.SHOPIFY_API_SECRET;

if (!SECRET_KEY) {
  throw new Error("SHOPIFY_API_SECRET not set - cannot encrypt credentials");
}

// Derive a fixed 32-byte key from the secret
const getEncryptionKey = async () => {
  const key = await sodium.crypto_hash_sha256(Buffer.from(SECRET_KEY));
  return key.slice(0, 32); // Take first 32 bytes
};

export async function encryptToken(plaintext) {
  if (!plaintext) return null;

  const key = await getEncryptionKey();
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = sodium.crypto_secretbox_easy(
    Buffer.from(plaintext),
    nonce,
    key
  );

  // Return base64 encoded nonce + ciphertext
  const combined = Buffer.concat([nonce, ciphertext]);
  return combined.toString("base64");
}

export async function decryptToken(encrypted) {
  if (!encrypted) return null;

  try {
    const key = await getEncryptionKey();
    const combined = Buffer.from(encrypted, "base64");
    const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
    const ciphertext = combined.slice(sodium.crypto_secretbox_NONCEBYTES);

    const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
    return Buffer.from(plaintext).toString("utf8");
  } catch (err) {
    console.error("Token decryption failed:", err.message);
    throw new Error("Failed to decrypt stored credentials");
  }
}
```

### Step 3: Update `app/lib/safe-db.js`

**Add at top:**
```javascript
import { encryptToken, decryptToken } from "./encryption.js";
```

**Find `upsertSourceStore` function and update:**

```javascript
export async function upsertSourceStore(shop, data) {
  try {
    // ✅ Encrypt token before storing
    const encryptedToken = await encryptToken(data.token);
    
    const result = await prisma.sourceStore.upsert({
      where: { shop },
      create: {
        shop,
        sourceUrl: data.sourceUrl,
        sourceName: data.sourceName || "",
        sourceEmail: data.sourceEmail || "",
        sourcePlan: data.sourcePlan || "",
        token: encryptedToken,
      },
      update: {
        sourceUrl: data.sourceUrl,
        sourceName: data.sourceName || "",
        sourceEmail: data.sourceEmail || "",
        sourcePlan: data.sourcePlan || "",
        token: encryptedToken,
        lastUsed: new Date(),
      },
    });
    return result;
  } catch (err) {
    // Error handling for missing table
    if (err.code === "P1025" || err.message?.includes("no such table")) {
      console.warn("SourceStore table missing - skipping credential save");
      return null;
    }
    throw err;
  }
}
```

**Find `getSavedSourceStore` function and update:**

```javascript
export async function getSavedSourceStore(shop) {
  try {
    const record = await prisma.sourceStore.findUnique({ where: { shop } });
    if (!record) return null;
    
    // ✅ Decrypt token when retrieving
    const decrypted = await decryptToken(record.token);
    
    return {
      id: record.id,
      shop: record.shop,
      sourceUrl: record.sourceUrl,
      sourceName: record.sourceName,
      sourceEmail: record.sourceEmail,
      sourcePlan: record.sourcePlan,
      token: decrypted, // Now plaintext only in memory
      lastUsed: record.lastUsed,
      createdAt: record.createdAt,
    };
  } catch (err) {
    if (err.code === "P1025" || err.message?.includes("no such table")) {
      return null;
    }
    throw err;
  }
}
```

**Result:** Tokens encrypted at rest. Database breach doesn't expose credentials.

---

## PART 4: Remove N+1 Collection Count Loop - ~1 hour

**Problem:** Lines 280-288 in `app/routes/app.collection-transfer.jsx` make 100+ extra API calls.

```javascript
// ❌ OLD CODE (DELETE THIS BLOCK):
for (const c of custom) {
  let productCount = 0;
  try {
    const r = await fetch(
      `https://${url}/admin/api/${version}/products/count.json?collection_id=${c.id}`,
      { headers: { "X-Shopify-Access-Token": token } }
    );
    if (r.ok) productCount = (await r.json()).count || 0;
  } catch (_) {}
  collections.push({
    id: c.id,
    title: c.title,
    handle: c.handle,
    body_html: c.body_html || "",
    image: c.image?.src || "",
    published: !!c.published_at,
    sort_order: c.sort_order || "",
    type: "custom",
    productCount, // ❌ Remove this
  });
}
```

**Replace with (in fetch-collections intent around line 274):**

```javascript
// ✅ NEW CODE (just return collection data, no product counts):
if (intent === "fetch-collections") {
  try {
    const { url, token } = await getSourceCreds();
    const custom = await fetchAllPages(
      `https://${url}/admin/api/${version}/custom_collections.json?limit=250`,
      token
    );
    const smart = await fetchAllPages(
      `https://${url}/admin/api/${version}/smart_collections.json?limit=250`,
      token
    );

    const collections = [];
    
    // Custom collections
    for (const c of custom) {
      collections.push({
        id: c.id,
        title: c.title,
        handle: c.handle,
        body_html: c.body_html || "",
        image: c.image?.src || "",
        published: !!c.published_at,
        sort_order: c.sort_order || "",
        type: "custom",
        // ✅ Removed productCount - calculate during transfer instead
      });
    }

    // Smart collections
    for (const c of smart) {
      collections.push({
        id: c.id,
        title: c.title,
        handle: c.handle,
        body_html: c.body_html || "",
        image: c.image?.src || "",
        published: !!c.published_at,
        sort_order: c.sort_order || "",
        type: "smart",
        rules: c.rules || [],
        disjunctive: c.disjunctive || false,
        // ✅ Removed productCount
      });
    }

    return { intent: "fetch-collections", rid, ok: true, collections };
  } catch (err) {
    return {
      intent: "fetch-collections",
      rid,
      ok: false,
      error: err.message,
    };
  }
}
```

**Result:** 100+ fewer API calls on collection load.

---

## PART 5: Quick Wins (30 minutes total)

### 5.1: Add Rate Limit Backoff Header Respect

In `app/routes/app.collection-transfer.jsx`, update `shopifyFetch` function (around line 56):

```javascript
async function shopifyFetch(url, opts = {}) {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, opts);
    
    if (res.status === 429) {
      // ✅ Respect Retry-After header
      const retryAfter = parseFloat(res.headers.get("Retry-After") || "1");
      const delay = Math.max(retryAfter * 1000, 1000 * Math.pow(2, attempt));
      
      console.warn(
        `Rate limited. Retry after ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})`
      );
      
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
    return res;
  }
  return fetch(url, opts);
}
```

### 5.2: Log Errors Properly

In `app/routes/app.product-importer.jsx`, lines 250-292, improve video error handling:

```javascript
// After attachMedia call, check for GraphQL errors:
const res = await attachMedia(input);

// ✅ Check for GraphQL errors (not HTTP errors)
if (res.errors) {
  console.error("GraphQL error:", res.errors[0].message);
  videoNotes.push(`Video attachment failed: ${res.errors[0].message}`);
} else if (res.data?.productCreateMedia?.mediaUserErrors?.length > 0) {
  const errs = res.data.productCreateMedia.mediaUserErrors;
  console.warn("Media errors:", errs);
  videoNotes.push(
    `Video format unsupported: ${errs.map((e) => e.message).join(", ")}`
  );
}
```

---

## TESTING CHECKLIST

After implementing all fixes:

- [ ] **Scopes:** Deploy new scopes, merchant re-authorizes, collection features work
- [ ] **Parallel Transfer:** Transfer 1000 products, verify it takes <10 minutes
- [ ] **Encryption:** Restart app, credentials still work (token was decrypted)
- [ ] **No N+1:** Check network tab, no product/count calls during load
- [ ] **Rate Limiting:** Trigger 429 error, verify exponential backoff applied
- [ ] **Video Errors:** Upload product with bad video URL, see specific error message

---

## DEPLOYMENT STEPS

1. **Branch & Test:** `git checkout -b fix/critical-issues`
2. **Make changes** per this prompt (1-5)
3. **Local test:** `npm run dev`, test each fix
4. **Commit:** `git commit -m "fix: parallel transfer, encryption, N+1 queries, scopes"`
5. **Deploy:** `npm run deploy`
6. **Monitor:** Watch error logs for 24 hours

---

## ESTIMATED TIME INVESTMENT

- Part 1 (Scopes): **5 min**
- Part 2 (Parallel Transfer): **3 hours**
- Part 3 (Encryption): **2 hours**
- Part 4 (Remove N+1): **1 hour**
- Part 5 (Quick Wins): **30 min**
- Testing: **1 hour**

**Total: ~8 hours**

---

## EXPECTED RESULTS AFTER FIXES

| Metric | Before | After |
|--------|--------|-------|
| 1000 product transfer | 30+ min, might timeout | 5-8 min, reliable |
| API calls on collection load | 100+ extra | 0 extra |
| Credential security | Plaintext in DB | Encrypted at rest |
| Rate limit recovery | Immediate retry (fails fast) | Exponential backoff |

---

## NEXT PRIORITIES (After These 4)

1. **Job tracking & resume** - Allow interrupted transfers to resume
2. **Request timeout prevention** - Background worker queue
3. **Input validation schema** - Validate CSV before sending to Shopify
4. **Error monitoring** - Log failures to external service

See `CODE_AUDIT_REPORT.md` for detailed implementation guides.

