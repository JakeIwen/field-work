import { readPromotionManifests } from "./backup-promotions.js";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { inspectBackupIntegrity } from "./backup-integrity.js";
import { now, type Store } from "./storage.js";

type BackupFiles = Record<string, Uint8Array>;

function addDrafts(store: Store, files: BackupFiles, dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || ["node_modules", ".git"].includes(entry.name))
      continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) addDrafts(store, files, p);
    else if (
      /\.(md|html|txt|pdf|json|swift|ts|tsx|css|js|mjs|png|gz)$/.test(
        entry.name,
      )
    )
      files[path.relative(store.dataDir, p)] = readFileSync(p);
  }
}

export function createBackupArchive(store: Store) {
  store.flushExport();
  const stamp = now().replace(/[:.]/g, "-");
  const temp = path.join(store.dataDir, `backup-${stamp}.sqlite`);
  store.db.exec(`VACUUM INTO '${temp.replaceAll("'", "''")}'`);
  try {
    const files: BackupFiles = {
      "workspace.sqlite": readFileSync(temp),
      "personal-export.json": readFileSync(
        path.join(store.dataDir, "personal-export.json"),
      ),
      "RESTORE.txt": strToU8(
        "Stop the app. Restore workspace.sqlite and objects/ into JOB_SEARCH_DATA (default <repository>/.local/job-search). Keep a copy of the existing data first. Then run npm --prefix platform start from the repository root. Paths are repository-relative; source caches can be rebuilt with npm --prefix platform run import. Task draft files, when present, are included under drafts/.",
      ),
    };
    for (const name of ["codex-threads.json", "claude-threads.json"]) {
      const registry = path.join(store.dataDir, name);
      if (existsSync(registry) && !lstatSync(registry).isSymbolicLink())
        files[name] = readFileSync(registry);
    }
    for (const name of ["drafts", "careers-scans"]) {
      const dir = path.join(store.dataDir, name);
      if (existsSync(dir) && !lstatSync(dir).isSymbolicLink())
        addDrafts(store, files, dir);
    }
    const promotions = readPromotionManifests(store);
    for (const manifest of promotions)
      files[`promotions/${manifest.name}`] = manifest.bytes;
    const integrity = inspectBackupIntegrity(
      store,
      (id, bytes) => {
        files[`objects/${id}`] = bytes;
      },
      promotions,
    );
    files["backup-integrity.json"] = strToU8(
      JSON.stringify(integrity, null, 2),
    );
    return { bytes: zipSync(files), integrity };
  } finally {
    unlinkSync(temp);
  }
}
