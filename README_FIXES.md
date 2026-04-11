# Importzo - Fix Implementation Guide

**Created:** April 11, 2026  
**Status:** Ready to implement

---

## 📂 What Was Analyzed

Your Shopify bulk import/export app that handles:
- Product imports from CSV
- Collection transfers between stores
- Customer data exports
- Inventory management
- Theme asset uploads

---

## 🎯 Three Documents Created

### 1. **SCOPE_ANALYSIS.md** ⭐ START HERE
- **What:** Lists all missing Shopify scopes
- **Time to read:** 5 minutes
- **Action:** Update `shopify.app.toml` with 4 required scopes
- **Link:** See "Missing Scopes" section

### 2. **MASTER_FIX_PROMPT.md** ⭐ IMPLEMENTATION GUIDE
- **What:** Step-by-step code fixes for critical issues
- **Time to implement:** ~8 hours
- **Fixes included:**
  1. ✅ Add missing Shopify scopes (5 min)
  2. ✅ Parallel product transfer - 6x faster (3 hrs)
  3. ✅ Encrypt stored credentials - security fix (2 hrs)
  4. ✅ Remove N+1 query loops - 100 fewer API calls (1 hr)
  5. ✅ Quick wins - rate limiting, error handling (30 min)

### 3. **CODE_AUDIT_REPORT.md** 📊 REFERENCE
- **What:** Deep dive into all 11 issues found
- **Why:** Understand problems before fixing
- **Useful for:** Post-fix planning, monitoring, testing

---

## 🚀 Quick Start (30 minutes)

### Do This First

**Step 1: Add Missing Scopes (5 min)**
```bash
# Edit shopify.app.toml, line 25
# Replace scopes line with version from MASTER_FIX_PROMPT.md Part 1
# Takes 60 seconds
```

**Step 2: Read MASTER_FIX_PROMPT.md Part 2-4 (15 min)**
- Understand the architecture changes needed
- No coding yet, just read

**Step 3: Make a Branch (10 min)**
```bash
git checkout -b fix/critical-issues
```

---

## 📋 Implementation Checklist

### Before You Start
- [ ] Read SCOPE_ANALYSIS.md (5 min)
- [ ] Read MASTER_FIX_PROMPT.md entirely (20 min)
- [ ] Create feature branch: `git checkout -b fix/critical-issues`

### Implementation (in order)
- [ ] **Part 1** - Update scopes in shopify.app.toml (5 min)
- [ ] **Part 2** - Create batch-processor.js (1 hr)
- [ ] **Part 2** - Refactor collection-transfer.jsx transfer intent (2 hrs)
- [ ] **Part 3** - Create encryption.js (30 min)
- [ ] **Part 3** - Update safe-db.js with encryption calls (1 hr)
- [ ] **Part 4** - Remove N+1 loop, simplify collection fetch (1 hr)
- [ ] **Part 5** - Add rate limit backoff header respect (15 min)
- [ ] **Part 5** - Improve video error messages (15 min)

### Testing
- [ ] Local test with `npm run dev`
- [ ] Verify each fix per checklist in MASTER_FIX_PROMPT.md
- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes

### Deployment
- [ ] Commit with clear message
- [ ] Deploy to staging first
- [ ] Verify in test store
- [ ] Deploy to production
- [ ] Monitor logs for 24 hours

---

## 💡 Key Issues Fixed

| Issue | Severity | Fix Time | Impact |
|-------|----------|----------|--------|
| Transfers take 30+ min for 1000 products | 🔴 | 3 hrs | 6x faster |
| 100+ unnecessary API calls on load | 🔴 | 1 hr | Cleaner API usage |
| Access tokens stored unencrypted | 🔴 | 2 hrs | Security compliance |
| Sequential processing bottleneck | 🔴 | Included | Parallel execution |
| Rate limiting errors with retries | 🟠 | 15 min | Better reliability |
| Poor error messages on video upload | 🟠 | 15 min | Better UX |

---

## 🎓 What You'll Learn

Implementing these fixes teaches you:

1. **Batch Processing Pattern** - Process many items efficiently
2. **Encryption at Rest** - Secure credential storage
3. **Shopify API Rate Limits** - Proper backoff strategies
4. **Promise.allSettled** - Parallel processing with error handling
5. **Remix/React Router** - Action patterns for long operations

---

## 📊 Expected Results

| Metric | Before | After |
|--------|--------|-------|
| Transfer 1000 products | 30-45 min | 5-8 min |
| Collection page load API calls | 100+ extra | 0 extra |
| Credential security | ❌ Plaintext | ✅ Encrypted |
| Rate limit handling | Basic | ✅ Exponential backoff |
| Error clarity | Generic messages | ✅ Specific errors |

---

## 🔍 How to Use These Documents

### Scenario 1: "I just want to fix it"
1. Open **MASTER_FIX_PROMPT.md**
2. Follow Parts 1-5 in order
3. Test per checklist
4. Deploy

### Scenario 2: "I want to understand the problems first"
1. Read **CODE_AUDIT_REPORT.md** sections 1-4
2. Then follow MASTER_FIX_PROMPT.md Parts 1-5
3. Reference CODE_AUDIT_REPORT.md for details on monitoring

### Scenario 3: "I need to explain this to my team"
1. Share **SCOPE_ANALYSIS.md** - shows what scopes are missing
2. Share **CODE_AUDIT_REPORT.md** - shows all issues with severity
3. Share **MASTER_FIX_PROMPT.md** - shows exact fixes needed

### Scenario 4: "I want to implement this over time"
1. **This sprint:** Part 1 (Scopes) + Part 4 (N+1) = 1 hour
2. **Next sprint:** Part 2 (Parallel) = 3 hours
3. **Following sprint:** Part 3 (Encryption) = 2 hours
4. **Later:** Parts 5 + other items from CODE_AUDIT_REPORT.md

---

## ⚠️ Important Notes

1. **Scopes require merchant re-auth** - When deployed, merchants will see a re-authorization prompt
2. **Encryption key is SHOPIFY_API_SECRET** - Make sure this is set in all environments
3. **Batch size is 10** - Adjust if you hit rate limits (try 5) or have headroom (try 15)
4. **Tests are recommended** - Add unit tests for batch-processor.js once implemented

---

## 🆘 If You Get Stuck

### "Batch processor isn't working"
- Check promise.allSettled() syntax in Node version
- Verify all products are being processed (count results)
- Check network tab for 429 errors

### "Encryption failing"
- Verify SHOPIFY_API_SECRET is set: `echo $SHOPIFY_API_SECRET`
- Check libsodium is installed: `npm ls libsodium.js`
- Ensure decryption happens before token is used

### "Collection transfer still slow"
- Verify batchSize=10 in batchProcess call
- Check no sequential awaits remain in the loop
- Profile with console.time() around batchProcess

---

## 🎯 Success Criteria

✅ You'll know it's working when:

1. Scopes deployed → Merchants can see collection options
2. Batch processor implemented → 1000 product transfer takes 5-8 min
3. Encryption added → Database file doesn't show plaintext tokens
4. N+1 removed → Collection load doesn't make 100+ extra API calls
5. Tests pass → npm run lint and npm run typecheck clean

---

## 📞 Architecture Support

After implementing, if you want to add:
- **Progress tracking** → See "Job Tracking & Cancellation" in CODE_AUDIT_REPORT.md
- **Resume failed transfers** → Same section
- **Request timeout prevention** → "Request Timeout Risk" section
- **Data validation** → "No Input Validation" section

These all build on the fixes in MASTER_FIX_PROMPT.md.

---

## 📝 Next Steps

1. **Today:** Read all three documents
2. **Tomorrow:** Implement MASTER_FIX_PROMPT.md Part 1 + 4 (1 hour)
3. **This week:** Implement Parts 2-3 (5 hours)
4. **Next week:** Test, deploy, monitor
5. **Later:** Reference CODE_AUDIT_REPORT.md for Phase 2 improvements

---

**Questions?** Re-read the relevant section in the documents - they're designed to be self-contained and answer common implementation questions.

