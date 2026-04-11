import { describe, it, expect } from "vitest";
import { parseCSV } from "./csv-parser.js";

describe("parseCSV", () => {
  // ── Basic functionality ──
  it("parses simple comma-delimited CSV", () => {
    const result = parseCSV("Name,Age\nAlice,30\nBob,25");
    expect(result).toEqual([["Name", "Age"], ["Alice", "30"], ["Bob", "25"]]);
  });

  it("parses semicolon-delimited CSV", () => {
    const result = parseCSV("Name;Age\nAlice;30");
    expect(result).toEqual([["Name", "Age"], ["Alice", "30"]]);
  });

  it("parses tab-delimited CSV", () => {
    const result = parseCSV("Name\tAge\nAlice\t30");
    expect(result).toEqual([["Name", "Age"], ["Alice", "30"]]);
  });

  // ── BOM handling ──
  it("strips UTF-8 BOM", () => {
    const bom = "\uFEFF";
    const result = parseCSV(bom + "Title,Price\nShirt,29.99");
    expect(result[0][0]).toBe("Title");
  });

  // ── Quoted fields ──
  it("handles quoted fields with commas", () => {
    const result = parseCSV('Name,Desc\n"Widget, Pro","A great, useful item"');
    expect(result[1]).toEqual(["Widget, Pro", "A great, useful item"]);
  });

  it("handles escaped double quotes inside quoted fields", () => {
    const result = parseCSV('Name,Desc\nWidget,"Say ""hello"" world"');
    expect(result[1][1]).toBe('Say "hello" world');
  });

  it("handles newlines inside quoted fields", () => {
    const result = parseCSV('Name,Desc\nWidget,"Line 1\nLine 2"');
    expect(result[1][1]).toBe("Line 1\nLine 2");
  });

  // ── Edge cases ──
  it("returns empty array for empty string", () => {
    expect(parseCSV("")).toEqual([]);
  });

  it("returns empty array for whitespace-only input", () => {
    expect(parseCSV("   \n  \n  ")).toEqual([]);
  });

  it("skips empty rows", () => {
    const result = parseCSV("A,B\n1,2\n,,\n3,4");
    expect(result).toEqual([["A", "B"], ["1", "2"], ["3", "4"]]);
  });

  it("handles single column CSV", () => {
    const result = parseCSV("Name\nAlice\nBob");
    expect(result).toEqual([["Name"], ["Alice"], ["Bob"]]);
  });

  it("handles trailing newline", () => {
    const result = parseCSV("A,B\n1,2\n");
    expect(result).toEqual([["A", "B"], ["1", "2"]]);
  });

  it("handles \\r\\n line endings", () => {
    const result = parseCSV("A,B\r\n1,2\r\n3,4");
    expect(result).toEqual([["A", "B"], ["1", "2"], ["3", "4"]]);
  });

  it("handles \\r line endings", () => {
    const result = parseCSV("A,B\r1,2\r3,4");
    expect(result).toEqual([["A", "B"], ["1", "2"], ["3", "4"]]);
  });

  it("trims whitespace from fields", () => {
    const result = parseCSV("  Name ,  Age  \n  Alice , 30  ");
    expect(result).toEqual([["Name", "Age"], ["Alice", "30"]]);
  });

  // ── Delimiter auto-detection ──
  it("picks semicolon when it appears more than comma", () => {
    const result = parseCSV("A;B;C\n1;2;3");
    expect(result).toEqual([["A", "B", "C"], ["1", "2", "3"]]);
  });

  it("picks tab when it appears most", () => {
    const result = parseCSV("A\tB\tC\tD\n1\t2\t3\t4");
    expect(result).toEqual([["A", "B", "C", "D"], ["1", "2", "3", "4"]]);
  });

  // ── Large / realistic data ──
  it("handles Shopify-style product CSV", () => {
    const csv = [
      "Handle,Title,Body (HTML),Vendor,Product Type,Tags,Published,Option1 Name,Option1 Value,Variant SKU,Variant Price,Image Src",
      'basic-tee,"Basic Tee","<p>A classic tee</p>",Importzo,Apparel,"cotton, basics",TRUE,Size,Small,BT-SM,19.99,https://example.com/img.jpg',
      "basic-tee,,,,,,,,Medium,BT-MD,19.99,",
    ].join("\n");
    const result = parseCSV(csv);
    expect(result.length).toBe(3);
    expect(result[0][0]).toBe("Handle");
    expect(result[1][1]).toBe("Basic Tee");
    expect(result[1][5]).toBe("cotton, basics");
    expect(result[2][8]).toBe("Medium");
  });

  it("handles file with only headers (no data)", () => {
    const result = parseCSV("Name,Email,Phone");
    expect(result).toEqual([["Name", "Email", "Phone"]]);
  });

  // ── Duplicate column names (should parse, mapping handles dedup) ──
  it("preserves duplicate column headers", () => {
    const result = parseCSV("Name,Name,Price\nA,B,10");
    expect(result[0]).toEqual(["Name", "Name", "Price"]);
  });
});
