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

export function mockActionRequest(fields, { url = "https://dest-shop.myshopify.com/app/test" } = {}) {
  return { formData: async () => buildFormData(fields), url };
}
