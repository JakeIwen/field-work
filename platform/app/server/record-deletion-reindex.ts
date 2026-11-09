import path from "node:path";
import { COMPANY_PATH } from "./import/parse-companies.js";
import { OPENINGS_PATH } from "./import/parse-openings.js";
import { STATE_PATH } from "./import/scan-state.js";
import type { Store } from "./storage.js";
import type { DeletionRow } from "./record-deletion-records.js";

/** The importer reconciles cached source records, scan evidence and source hashes;
 * runtime objects, drafts and personal-only records are not inputs. */
export function deletionNeedsReindex(
  store: Store,
  chosen: DeletionRow[],
  updates: DeletionRow[],
  files: Iterable<string>,
): boolean {
  if (
    [...chosen, ...updates].some(
      (row) =>
        ["cache_company", "cache_opening", "cache_document"].includes(
          row.kind,
        ) ||
        (row.kind === "meta" && row.id === "import"),
    )
  )
    return true;
  for (const file of files) {
    const relative = path.relative(store.root, file).split(path.sep).join("/");
    if (
      [
        COMPANY_PATH,
        OPENINGS_PATH,
        STATE_PATH,
        "company_careers/scan_history.md",
      ].includes(relative)
    )
      return true;
    if (
      /^company_careers\/research\/scans\/.+\/(qualified_openings\.json|company_results\.json|selected-source-jobs\.json|README\.md)$/.test(
        relative,
      )
    )
      return true;
  }
  return false;
}
