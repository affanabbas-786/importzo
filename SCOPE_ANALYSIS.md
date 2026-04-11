# Shopify App Scope Analysis for Importzo

**Current Date:** April 11, 2026  
**App Client ID:** 70b047c7b1057f7a8ca94c044f6568ae  
**API Version:** 2026-04

---

## Current Scopes (In shopify.app.toml)

```
write_metaobject_definitions
write_metaobjects
write_products
read_products
write_customers
read_customers
read_inventory
write_inventory
```

---

## Functionality Overview

Your app is a sophisticated **bulk import/export and data transfer tool** that performs:

1. **Product Operations** - Import/export products from CSV, handle variants, pricing, inventory
2. **Collection Management** - Create and manage custom/smart collections
3. **Collection Transfer** - Copy collections and products between stores
4. **Customer Management** - Export customer data
5. **Inventory Management** - Update stock levels across locations
6. **Theme Asset Handling** - Upload images as theme assets
7. **Cross-Store Integration** - Pull data from source Shopify stores

---

## API Endpoints Being Used

| Endpoint | Method | Current Scope | Need to Add? |
|----------|--------|---------------|--------------|
| `/products.json` | POST/PUT | write_products ✓ | No |
| `/products.json` | GET | read_products ✓ | No |
| `/customers.json` | GET | read_customers ✓ | No |
| `/customers.json` | PUT | write_customers ✓ | No |
| `/inventory.json` | GET | read_inventory ✓ | No |
| `/inventory_levels.json` | POST | write_inventory ✓ | No |
| `/custom_collections.json` | POST | **Missing** | **YES - write_collections** |
| `/custom_collections/count.json` | GET | **Missing** | **YES - read_collections** |
| `/smart_collections.json` | POST | **Missing** | **YES - write_collections** |
| `/smart_collections/count.json` | GET | **Missing** | **YES - read_collections** |
| `/collects.json` | POST | **Missing** | **YES - write_collections** |
| `/themes.json` | GET/POST | **Missing** | **YES - write_themes & read_themes** |
| `/themes/{id}/assets.json` | PUT | **Missing** | **YES - write_themes** |
| `/shop.json` | GET | **Missing (optional)** | Consider: read_shop_info |
| `/locations.json` | GET | **Missing (optional)** | Consider: read_locations |
| Metaobjects | - | write_metaobjects ✓ | No |

---

## Missing Scopes - Breakdown

### 1. **write_collections** (REQUIRED) ⭐⭐⭐
**Why you need it:**
- Creating custom collections (`POST /custom_collections.json`)
- Creating smart collections (`POST /smart_collections.json`)
- Adding products to collections (`POST /collects.json`)
- Managing collection rules and products during transfer operations

**Where it's used:**
- `app.collections.jsx` - Collection import functionality
- `app.collection-transfer.jsx` - Cross-store collection transfers

---

### 2. **read_collections** (REQUIRED) ⭐⭐⭐
**Why you need it:**
- Fetching collection counts for dashboard display
- Reading collection data during export operations
- Validating collections before transfer

**Where it's used:**
- `app.collection-transfer.jsx` - Counts and data fetch
- Export/stats endpoints

---

### 3. **write_themes** (REQUIRED) ⭐⭐
**Why you need it:**
- Creating theme duplicates for image uploads (`POST /themes.json`)
- Uploading product collection images as theme assets (`PUT /themes/{id}/assets.json`)
- Managing theme assets during collection transfer

**Where it's used:**
- `app.collection-transfer.jsx` - Theme/image handling
- Asset management in collection operations

---

### 4. **read_themes** (REQUIRED) ⭐⭐
**Why you need it:**
- Fetching available themes to select which theme to upload assets to
- Reading theme list for validation
- Displaying theme info in collection transfer UI

**Where it's used:**
- `app.collection-transfer.jsx` - Theme selection and discovery

---

### 5. **read_locations** (OPTIONAL) ⭐
**Why it might help:**
- Better inventory management when updating stock across multiple fulfillment locations
- Ensures inventory is being set for correct location contexts
- Prevents inventory update conflicts

**Current status:** Your `read_inventory` and `write_inventory` scopes handle basic inventory, but `read_locations` would improve multi-location workflows

**Where it could be used:**
- `app.inventory.jsx` - Location-specific inventory updates

---

### 6. **read_shop_info** (OPTIONAL) ⭐
**Why it's nice to have:**
- Fetching shop data (plan, currency, timezone) for validation
- Better error messages and UX
- Currently you're using `/shop.json` without explicit scope

**Current status:** Likely working without explicit scope, but best practice is to include it

---

## Recommended Action Plan

### High Priority (Add Immediately)
```toml
scopes = "write_metaobject_definitions,write_metaobjects,write_products,read_products,write_customers,read_customers,read_inventory,write_inventory,write_collections,read_collections,write_themes,read_themes"
```

### If Supporting Multi-Location Inventory
Add `read_locations` to the high-priority list above.

### If Supporting Shop-Level Operations
Add `read_shop_info` to optimize shop info fetching.

---

## Updated shopify.app.toml (Recommended)

Replace your `[access_scopes]` section with:

```toml
[access_scopes]
scopes = "write_metaobject_definitions,write_metaobjects,write_products,read_products,write_customers,read_customers,read_inventory,write_inventory,write_collections,read_collections,write_themes,read_themes,read_locations"
```

Or without optional scopes:

```toml
[access_scopes]
scopes = "write_metaobject_definitions,write_metaobjects,write_products,read_products,write_customers,read_customers,read_inventory,write_inventory,write_collections,read_collections,write_themes,read_themes"
```

---

## Scope Update Process

After updating `shopify.app.toml`:

1. **Deploy with new scopes** - Push code with updated configuration
2. **Merchants will see scope request** - When they next open your app, they'll be prompted to re-authorize with new scopes
3. **Webhook handled** - Your app has `app/scopes_update` webhook configured to handle this gracefully
4. **No functionality breaks** - Existing operations continue; new features unlock when scope is granted

---

## Summary of Changes

| Scope | Status | Justification |
|-------|--------|---------------|
| write_metaobject_definitions | ✓ Keep | Needed for metaobject definitions |
| write_metaobjects | ✓ Keep | Needed for metaobject records |
| write_products | ✓ Keep | Product creation/updates |
| read_products | ✓ Keep | Product reading/export |
| write_customers | ✓ Keep | Customer updates |
| read_customers | ✓ Keep | Customer export |
| read_inventory | ✓ Keep | Inventory reading |
| write_inventory | ✓ Keep | Inventory updates |
| **write_collections** | 🆕 **ADD** | Create collections (custom & smart) |
| **read_collections** | 🆕 **ADD** | Read collection counts & data |
| **write_themes** | 🆕 **ADD** | Upload theme assets (images) |
| **read_themes** | 🆕 **ADD** | List/read themes for selection |
| read_locations | ⭐ Consider | Multi-location inventory support |

