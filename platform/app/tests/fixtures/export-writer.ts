import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import type { Store } from "../../server/storage.js";

/** Real rename failure after writing the temporary export, without changing SQLite. */
export function blockPersonalExport(store: Store) {
  const file = path.join(store.dataDir, "personal-export.json");
  mkdirSync(file);
  return () => rmSync(file, { recursive: true, force: true });
}
