import { describe, it, expect } from "vitest";
import { destinationThemeName, truncateAtWord, THEME_NAME_MAX } from "./theme-zip.server.js";

describe("truncateAtWord", () => {
  it("leaves a short value untouched", () => {
    expect(truncateAtWord("Dawn", 20)).toBe("Dawn");
  });

  it("cuts at the last word boundary rather than mid-word", () => {
    expect(truncateAtWord("Premium Multipurpose Fashion Theme", 25)).toBe("Premium Multipurpose");
  });

  it("falls back to a hard cut when honouring the boundary would lose too much", () => {
    // One very long word: backing up to the (nonexistent) space would leave
    // nothing, so a mid-word cut is the better of the two bad options.
    expect(truncateAtWord("Supercalifragilisticexpialidocious", 20)).toBe("Supercalifragilistic");
  });

  it("trims surrounding whitespace", () => {
    expect(truncateAtWord("   Dawn   ", 20)).toBe("Dawn");
  });

  it("handles null and undefined without throwing", () => {
    expect(truncateAtWord(null, 10)).toBe("");
    expect(truncateAtWord(undefined, 10)).toBe("");
  });
});

describe("destinationThemeName", () => {
  // The bug: Shopify rejects >50 chars with
  // "HTTP 422: Name is too long (maximum is 50 characters)".
  it("never exceeds Shopify's 50-character limit", () => {
    const names = [
      "Dawn",
      "Impulse - Premium Multipurpose Shopify Theme for Fashion Stores",
      "Supercalifragilisticexpialidociousultramegathemename",
      "A".repeat(300),
      "Warehouse — Electronics, Tools & Multipurpose Store Theme 2026 Edition",
    ];
    for (const name of names) {
      const out = destinationThemeName(name);
      expect(out.length).toBeLessThanOrEqual(THEME_NAME_MAX);
    }
  });

  it("keeps the (Transferred) marker even when the name is truncated", () => {
    const out = destinationThemeName("Impulse - Premium Multipurpose Shopify Theme for Fashion Stores");
    expect(out.endsWith(" (Transferred)")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(THEME_NAME_MAX);
  });

  it("passes a short name through with just the marker appended", () => {
    expect(destinationThemeName("Dawn")).toBe("Dawn (Transferred)");
  });

  it("truncates at a word boundary, not mid-word", () => {
    const out = destinationThemeName("Warehouse Electronics Tools Multipurpose Store Theme");
    expect(out).toBe("Warehouse Electronics Tools (Transferred)");
  });

  it("substitutes a default for an empty source name", () => {
    expect(destinationThemeName("")).toBe("Transferred Theme (Transferred)");
    expect(destinationThemeName(null)).toBe("Transferred Theme (Transferred)");
  });

  // The create call and the "already exists?" idempotency check both call
  // this. If it were not deterministic, a re-run would stop recognising the
  // theme it made last time and duplicate it — the exact failure the
  // idempotency check exists to prevent.
  it("is deterministic for the same input", () => {
    const name = "Impulse - Premium Multipurpose Shopify Theme for Fashion Stores";
    expect(destinationThemeName(name)).toBe(destinationThemeName(name));
  });
});
