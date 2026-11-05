/**
 * Reads the numbers table out of RESULTS.md. The video never holds a number of its own: a slide or a
 * voice-over line names a cell, and a cell with no number yet reads "pending".
 */
export const PENDING = "pending";

export interface ResultRow {
  id: string;
  metric: string;
  baseline: string;
  clearance: string;
  data: string;
  script: string;
}

const COLUMNS = ["metric", "baseline", "clearance", "data", "script"] as const;
export type ResultColumn = (typeof COLUMNS)[number];

/** The rows of the first table with the `ID | Metric | ...` header. Cells are kept as written. */
export function parseResults(markdown: string): ResultRow[] {
  const lines = markdown.split("\n");
  const header = lines.findIndex((line) => /^\|\s*ID\s*\|\s*Metric\s*\|/.test(line));
  if (header < 0) throw new Error("RESULTS.md has no table with an ID | Metric header");
  const rows: ResultRow[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.trim().startsWith("|")) break;
    const cells = line
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split(/(?<!\\)\|/)
      .map((cell) => cell.trim().replace(/\\\|/g, "|"));
    if (cells.length !== 6) {
      throw new Error(`RESULTS.md row has ${cells.length} cells, expected 6: ${line}`);
    }
    const [id, metric, baseline, clearance, data, script] = cells as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    rows.push({ id, metric, baseline, clearance, data, script });
  }
  return rows;
}

/** A cell as a viewer should read it: no markup, and every blank says "pending". */
export function showCell(cell: string): string {
  const plain = cell.replace(/\*\*/g, "").replace(/`/g, "").trim();
  if (plain === "") return PENDING;
  return plain.replace(/(^|[\s(:,/])_(?=$|[\s),/])/g, `$1${PENDING}`);
}

/**
 * Finds a row. `E1` is enough when the id has one row; `E2/risky` narrows by a word in the metric, and
 * an id with several rows and no narrowing is an error, because guessing here puts a wrong number on
 * screen.
 */
export function selectRow(rows: ResultRow[], selector: string): ResultRow {
  const [id, narrow] = selector.split("/") as [string, string | undefined];
  const byId = rows.filter((row) => row.id === id);
  if (byId.length === 0) throw new Error(`RESULTS.md has no row ${id} (asked for "${selector}")`);
  const found = narrow
    ? byId.filter((row) => row.metric.toLowerCase().includes(narrow.toLowerCase()))
    : byId;
  if (found.length !== 1) {
    throw new Error(
      `"${selector}" matches ${found.length} rows in RESULTS.md. Metrics under ${id}: ${byId
        .map((row) => row.metric)
        .join("; ")}`,
    );
  }
  return found[0] as ResultRow;
}

/** The negative-result row keeps its words wherever report.ts put them: the first non-blank cell. */
function rowText(row: ResultRow): string {
  for (const cell of [row.clearance, row.baseline, row.data]) {
    if (showCell(cell) !== PENDING) return showCell(cell);
  }
  return PENDING;
}

/**
 * Fills `{{E1.clearance}}` and `{{NEG.text}}` from the table. An unknown cell name is an error rather
 * than a "pending": it's a typo in the script, not a result that hasn't arrived.
 */
export function resolveTemplate(text: string, rows: ResultRow[]): string {
  return text.replace(
    /\{\{\s*([A-Za-z0-9]+(?:\/[^.}\s]+)?)\.([a-z]+)\s*\}\}/g,
    (_all, selector: string, column: string) => {
      const row = selectRow(rows, selector);
      if (column === "text") return rowText(row);
      if (!(COLUMNS as readonly string[]).includes(column)) {
        throw new Error(`RESULTS.md has no column "${column}" (in {{${selector}.${column}}})`);
      }
      return showCell(row[column as ResultColumn]);
    },
  );
}

/** True while any named cell has no number yet. */
export function hasPending(resolved: string): boolean {
  return resolved.includes(PENDING);
}
