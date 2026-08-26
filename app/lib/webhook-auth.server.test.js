import { describe, it, expect, vi, beforeEach } from "vitest";

// ═══════════════════════════════════════════════════════════════════
// The rotation shim. What matters here is not that a valid webhook passes —
// the library does that — but the four things the shim itself can get wrong:
// falling back when it shouldn't, NOT falling back when it should, losing the
// request body between the two attempts, and reporting the wrong failure.
//
// Every request below is a REAL Request. That is deliberate: the pre-existing
// suite in test/routes/webhooks.test.js passes plain objects with no `method`,
// which take this module's non-POST short-circuit and never reach the
// fallback at all.
// ═══════════════════════════════════════════════════════════════════

const { primaryMock, previousMock, providerMock } = vi.hoisted(() => ({
  primaryMock: vi.fn(),
  previousMock: vi.fn(),
  providerMock: vi.fn(),
}));

vi.mock("../shopify.server.js", () => ({
  authenticate: { webhook: (...args) => primaryMock(...args) },
  previousSecretWebhookAuthenticator: () => providerMock(),
}));

const { authenticateWebhook } = await import("./webhook-auth.server.js");

const BODY = JSON.stringify({ shop_id: 1, note: "payload must survive the retry" });

const webhookRequest = (body = BODY) =>
  new Request("https://importzo.dazzletech.co/webhooks/shop/redact", {
    method: "POST",
    headers: { "X-Shopify-Hmac-Sha256": "sig", "X-Shopify-Topic": "shop/redact" },
    body,
  });

const ok = (extra = {}) => ({ shop: "merchant.myshopify.com", topic: "shop/redact", ...extra });
const rejection = (status) => new Response(undefined, { status });

beforeEach(() => {
  primaryMock.mockReset();
  previousMock.mockReset();
  providerMock.mockReset();
  providerMock.mockReturnValue(null); // no rotation in progress by default
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("authenticateWebhook — no rotation in progress", () => {
  it("returns the verified context unchanged", async () => {
    primaryMock.mockResolvedValue(ok({ payload: { a: 1 } }));

    const result = await authenticateWebhook(webhookRequest());

    expect(result).toEqual(ok({ payload: { a: 1 } }));
    expect(primaryMock).toHaveBeenCalledTimes(1);
  });

  it("rethrows an HMAC rejection exactly as the library threw it", async () => {
    const thrown = rejection(401);
    primaryMock.mockRejectedValue(thrown);

    await expect(authenticateWebhook(webhookRequest())).rejects.toBe(thrown);
  });

  it("does not consult a fallback that isn't configured", async () => {
    primaryMock.mockRejectedValue(rejection(401));

    await authenticateWebhook(webhookRequest()).catch(() => {});

    expect(previousMock).not.toHaveBeenCalled();
  });
});

describe("authenticateWebhook — rotation in progress", () => {
  beforeEach(() => providerMock.mockReturnValue((...args) => previousMock(...args)));

  it("never reaches the previous secret when the current one verifies", async () => {
    primaryMock.mockResolvedValue(ok());

    await authenticateWebhook(webhookRequest());

    expect(previousMock).not.toHaveBeenCalled();
  });

  it("accepts a delivery still signed with the previous secret", async () => {
    // The whole point: Shopify signs with the OLDEST UNREVOKED secret, so
    // this is what every genuine webhook looks like mid-rotation.
    primaryMock.mockRejectedValue(rejection(401));
    previousMock.mockResolvedValue(ok({ topic: "customers/redact" }));

    const result = await authenticateWebhook(webhookRequest());

    expect(result).toEqual(ok({ topic: "customers/redact" }));
    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(previousMock).toHaveBeenCalledTimes(1);
  });

  it("says so in the logs, naming the topic and shop", async () => {
    // This line is the signal for when the old secret can safely be revoked:
    // once it stops appearing, nothing is being signed with it any more.
    primaryMock.mockRejectedValue(rejection(401));
    previousMock.mockResolvedValue(ok());

    await authenticateWebhook(webhookRequest());

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("PREVIOUS API secret"));
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("shop/redact from merchant.myshopify.com"));
  });

  it("hands the SAME body to the retry", async () => {
    // The bug this guards: authenticate.webhook() consumes the request body,
    // so a naive retry re-reads an already-drained stream, verifies an empty
    // body, and rejects every genuine webhook — the exact failure the shim
    // exists to prevent.
    primaryMock.mockRejectedValue(rejection(401));
    previousMock.mockResolvedValue(ok());

    await authenticateWebhook(webhookRequest());

    const firstBody = await primaryMock.mock.calls[0][0].text();
    const retryBody = await previousMock.mock.calls[0][0].text();
    expect(firstBody).toBe(BODY);
    expect(retryBody).toBe(BODY);
  });

  it("preserves the signature headers on the retry", async () => {
    primaryMock.mockRejectedValue(rejection(401));
    previousMock.mockResolvedValue(ok());

    await authenticateWebhook(webhookRequest());

    const retried = previousMock.mock.calls[0][0];
    expect(retried.method).toBe("POST");
    expect(retried.headers.get("X-Shopify-Hmac-Sha256")).toBe("sig");
    expect(retried.headers.get("X-Shopify-Topic")).toBe("shop/redact");
  });

  it("reports the CURRENT secret's rejection when both secrets reject", async () => {
    // A forged request must fail the way it would with no rotation running —
    // not with whatever the fallback happened to throw.
    const fromCurrent = rejection(401);
    primaryMock.mockRejectedValue(fromCurrent);
    previousMock.mockRejectedValue(rejection(400));

    await expect(authenticateWebhook(webhookRequest())).rejects.toBe(fromCurrent);
  });

  it("does not retry a non-HMAC failure", async () => {
    // 400 (malformed/missing headers) and 405 don't become valid under a
    // different key; retrying only does the work twice before failing the same.
    for (const status of [400, 405, 500]) {
      primaryMock.mockReset();
      previousMock.mockReset();
      primaryMock.mockRejectedValue(rejection(status));

      await authenticateWebhook(webhookRequest()).catch(() => {});

      expect(previousMock).not.toHaveBeenCalled();
    }
  });

  it("does not retry a thrown Error (as opposed to a Response)", async () => {
    const boom = new Error("session storage is down");
    primaryMock.mockRejectedValue(boom);

    await expect(authenticateWebhook(webhookRequest())).rejects.toBe(boom);
    expect(previousMock).not.toHaveBeenCalled();
  });

  it("passes a non-POST straight through, without cloning a body onto it", async () => {
    // Constructing a Request with a body on a GET throws, so the shim must
    // short-circuit and let the library answer 405 itself.
    const get = new Request("https://importzo.dazzletech.co/webhooks/shop/redact", { method: "GET" });
    primaryMock.mockRejectedValue(rejection(405));

    await expect(authenticateWebhook(get)).rejects.toMatchObject({ status: 405 });
    expect(primaryMock).toHaveBeenCalledWith(get);
    expect(previousMock).not.toHaveBeenCalled();
  });
});
