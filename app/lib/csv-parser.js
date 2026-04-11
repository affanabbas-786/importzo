// ═══════════════════════════════════════════════════════════════════
// Shared CSV Parser — robust: BOM, auto-delimiter, whitespace trim, skip empty
// ═══════════════════════════════════════════════════════════════════
export function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
  }
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const firstLine = text.split("\n")[0] || "";
  let delimiter = ",";
  const counts = { ",": 0, ";": 0, "\t": 0 };
  let q = false;
  for (let c = 0; c < firstLine.length; c++) {
    if (firstLine[c] === '"') q = !q;
    if (!q && counts[firstLine[c]] !== undefined) counts[firstLine[c]]++;
  }
  if (counts["\t"] > counts[","] && counts["\t"] >= counts[";"]) {
    delimiter = "\t";
  } else if (counts[";"] > counts[","] && counts[";"] > counts["\t"]) {
    delimiter = ";";
  }

  const rows = [];
  let fields = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = "";
    } else if (char === "\n" && !inQuotes) {
      fields.push(current.trim());
      current = "";
      if (fields.some((f) => f !== "")) {
        rows.push(fields);
      }
      fields = [];
    } else {
      current += char;
    }
  }
  if (current || fields.length > 0) {
    fields.push(current.trim());
    if (fields.some((f) => f !== "")) {
      rows.push(fields);
    }
  }
  return rows;
}
