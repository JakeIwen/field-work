import type { Store } from "./storage.js";
import { personalExportKinds } from "./storage-export-snapshot.js";
import {
  greenhousePullFinished,
  type GreenhousePullStatus,
} from "../shared/greenhouse-pull.js";

export type PersonalExportKind = (typeof personalExportKinds)[number];
type ExportStore = Pick<Store, "db">;
const initialized = new WeakSet<ExportStore>();

/** Temporary triggers cover Store.put/remove and bulk SQL, and roll back with the write.
 * Nothing is added to the authoritative schema or a restored SQLite backup. */
export function initializePersonalExportChanges(store: ExportStore) {
  store.db.function(
    "personal_export_requests_export",
    (kind, previous, current) => {
      if (kind === "greenhouse_pull_candidate") return 0;
      if (kind !== "greenhouse_pull_run") return 1;
      // Starting/searching produces only secondary bookkeeping. Finishing requests
      // one bounded export so an otherwise idle completed ledger does not wait forever.
      return Number(
        current !== previous &&
          typeof current === "string" &&
          greenhousePullFinished(current as GreenhousePullStatus),
      );
    },
  );
  store.db.exec(`CREATE TEMP TABLE personal_export_dirty (
    kind TEXT PRIMARY KEY, requests_export INTEGER NOT NULL
  )`);
  const kinds = personalExportKinds.map((kind) => `'${kind}'`).join(",");
  const status = (row: string) => `CASE WHEN ${row}.kind='greenhouse_pull_run'
    AND json_valid(${row}.json) THEN json_extract(${row}.json, '$.status') END`;
  for (const operation of ["INSERT", "UPDATE", "DELETE"] as const) {
    const row = operation === "DELETE" ? "OLD" : "NEW";
    const previous = operation === "INSERT" ? "NULL" : status("OLD");
    const current = operation === "DELETE" ? "NULL" : status("NEW");
    store.db
      .exec(`CREATE TEMP TRIGGER personal_export_${operation.toLowerCase()}
      AFTER ${operation} ON main.records WHEN ${row}.kind IN (${kinds}) BEGIN
      INSERT INTO personal_export_dirty(kind, requests_export)
      VALUES (${row}.kind, personal_export_requests_export(${row}.kind, ${previous}, ${current}))
      ON CONFLICT(kind) DO UPDATE SET requests_export=MAX(requests_export, excluded.requests_export);
    END`);
  }
  // A bulk UPDATE may move a row between kinds; both arrays then need rebuilding.
  store.db.exec(`CREATE TEMP TRIGGER personal_export_moved_kind
    AFTER UPDATE OF kind ON main.records WHEN OLD.kind != NEW.kind AND OLD.kind IN (${kinds}) BEGIN
    INSERT INTO personal_export_dirty VALUES(OLD.kind, personal_export_requests_export(OLD.kind, NULL, NULL))
    ON CONFLICT(kind) DO UPDATE SET requests_export=MAX(requests_export, excluded.requests_export);
  END`);
  initialized.add(store);
}

export function personalExportChanges(store: ExportStore) {
  if (!initialized.has(store))
    return { kinds: new Set<PersonalExportKind>(), requested: false };
  const rows = store.db
    .prepare("SELECT kind, requests_export FROM personal_export_dirty")
    .all();
  return {
    // Only registry keys can enter this temporary table through the triggers above.
    kinds: new Set(rows.map((row) => row.kind as PersonalExportKind)),
    requested: rows.some((row) => row.requests_export === 1),
  };
}

export function clearPersonalExportChanges(store: ExportStore) {
  if (initialized.has(store))
    store.db.exec("DELETE FROM personal_export_dirty");
}
