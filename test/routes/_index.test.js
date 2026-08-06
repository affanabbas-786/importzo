import { describe, it, expect } from "vitest";
import { loader } from "../../app/routes/_index/route.jsx";

const request = (url) => new Request(url);

describe("/ (marketing landing route)", () => {
  // The outage this route caused: / redirected to https://importzo.dazzletech.co,
  // which IS /, so browsers looped until they hit their redirect cap.
  it("never redirects / back to itself", async () => {
    const response = await loader({ request: request("https://importzo.dazzletech.co/") }).catch((r) => r);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      expect(location).not.toBe("https://importzo.dazzletech.co");
      expect(location).not.toBe("https://importzo.dazzletech.co/");
      expect(new URL(location, "https://importzo.dazzletech.co").pathname).not.toBe("/");
    }
  });

  it("serves the landing page HTML directly, with no redirect", async () => {
    const response = await loader({ request: request("https://importzo.dazzletech.co/") });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/text\/html/);
    await expect(response.text()).resolves.toMatch(/<html|<!doctype/i);
  });

  // Shopify opens the app at / with ?shop= on install and from the admin.
  it("sends Shopify traffic to the embedded app, preserving the query string", async () => {
    const thrown = await loader({
      request: request("https://importzo.dazzletech.co/?shop=demo.myshopify.com&host=abc"),
    }).catch((r) => r);

    expect(thrown.status).toBe(302);
    const location = thrown.headers.get("location");
    expect(location).toMatch(/^\/app\?/);
    expect(location).toContain("shop=demo.myshopify.com");
    expect(location).toContain("host=abc");
  });
});
