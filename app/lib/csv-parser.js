// ═══════════════════════════════════════════════════════════════════
// Shared CSV Parser — robust: BOM, auto-delimiter, whitespace trim, skip empty
//
// parseCSVRows() is a generator: it yields each row as soon as it's
// complete instead of building the full 2D array up front. For very
// large files (50k+ rows), a caller that consumes rows one at a time
// (e.g. a for-of loop that processes-and-discards) never holds more
// than one row in memory at a time, and can `break` early without the
// remainder of the file ever being scanned.
//
// parseCSV() keeps the original eager array-returning signature for
// existing callers, implemented as a thin wrapper over the generator.
// ═══════════════════════════════════════════════════════════════════
export function* parseCSVRows(text) {
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
        yield fields;
      }
      fields = [];
    } else {
      current += char;
    }
  }
  if (current || fields.length > 0) {
    fields.push(current.trim());
    if (fields.some((f) => f !== "")) {
      yield fields;
    }
  }
}

export function parseCSV(text) {
  return [...parseCSVRows(text)];
}
