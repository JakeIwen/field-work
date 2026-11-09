import type { DatabaseSync } from "node:sqlite";
import type { Store } from "./storage.js";

const registered = new WeakSet<DatabaseSync>();
/** SQLite's built-in lower() folds ASCII only; names and titles also contain Unicode. */
export function initializeRecordSearch(store: Store) {
  if (registered.has(store.db)) return;
  store.db.function("record_lower", { deterministic: true }, (value) =>
    String(value ?? "").toLowerCase(),
  );
  registered.add(store.db);
}
