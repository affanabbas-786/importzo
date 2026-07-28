// Shared test-only helpers for building fake Shopify Admin API fetch
// responses and fake react-router action Request objects. Not shipped
// as part of the app runtime — imported only from *.test.js files.

export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => headers[k] ?? null },
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

export function buildFormData(fields) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    fd.append(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  return fd;
}

// Action requests are POST in practice; routes that guard on request.method
// need it present, so it defaults to POST rather than being undefined.
export function mockActionRequest(fields, { url = "https://dest-shop.myshopify.com/app/test", method = "POST" } = {}) {
  return { method, formData: async () => buildFormData(fields), url };
}
