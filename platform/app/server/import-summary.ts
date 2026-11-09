import type { RescanSummary, ImportChanges } from "../shared/rescan-summary.js";
import type { Company, Document, Opening } from "../shared/types.js";
type Population = "companies" | "openings" | "documents";
type PopulationRows = {
  companies: Company[];
  openings: Opening[];
  documents: Document[];
};
type ImportRow = PopulationRows[Population][number];
export type ImportSnapshot = PopulationRows & {
  sourceHashes: Record<string, string>;
};
const bookkeeping = new Set([
  "firstImportedAt",
  "sourceVerifiedAt",
  "lastAbsentFromSourceAt",
  "modifiedAt",
  "immutableCopyAvailable",
  "availableInSource",
  "sourceMissing",
]);
function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, stable((value as Record<string, unknown>)[k])]),
    );
  return value;
}
function comparable(row: ImportRow) {
  return JSON.stringify(
    stable(
      Object.fromEntries(
        Object.entries(row).filter(([k]) => !bookkeeping.has(k)),
      ),
    ),
  );
}
function present(kind: Population, row: ImportRow) {
  return kind === "documents"
    ? (row as Document).availableInSource !== false
    : kind === "companies"
      ? !(row as Company).sourceMissing
      : !(row as Opening).lastAbsentFromSourceAt;
}
function population(kind: Population, rows: ImportRow[]) {
  const map = new Map<string, ImportRow>();
  for (const row of rows) {
    const key = kind === "documents" ? (row as Document).path : row.id;
    // Documents retain immutable versions. Compare the currently available version
    // at each path, not each content-hashed document ID.
    if (
      !map.has(key) ||
      present(kind, row) ||
      !present(kind, map.get(key) as ImportRow)
    )
      map.set(key, row);
  }
  return map;
}
export function summarizeImport(
  before: ImportSnapshot,
  after: ImportSnapshot,
  incomplete: boolean,
): RescanSummary {
  const changes = (kind: Population): ImportChanges => {
    const counts = { added: 0, updated: 0, restored: 0, missing: 0 };
    const old = population(kind, before[kind]),
      next = population(kind, after[kind]);
    for (const [id, row] of next) {
      const previous = old.get(id);
      if (!present(kind, row)) {
        if (previous && present(kind, previous)) counts.missing++;
      } else if (!previous) counts.added++;
      else if (!present(kind, previous)) counts.restored++;
      else if (comparable(previous) !== comparable(row)) counts.updated++;
    }
    return counts;
  };
  return {
    companies: changes("companies"),
    openings: changes("openings"),
    documents: changes("documents"),
    incomplete,
    sourceFilesChanged: Object.keys(after.sourceHashes).filter(
      (key) => before.sourceHashes[key] !== after.sourceHashes[key],
    ).length,
  };
}
