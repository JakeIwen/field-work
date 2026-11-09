import { mkdtempSync, readdirSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { Store, atomicWrite } from "./storage.js";
import { inspectBackupIntegrity } from "./backup-integrity.js";

/** Extract data only into an empty private directory; never trust archive paths. */
export function extractBackup(archive: Uint8Array, directory: string) {
  if (readdirSync(directory).length)
    throw new Error("Restore target must be empty");
  let expanded = 0;
  const files = unzipSync(archive, {
    filter: (entry) => {
      const parts = entry.name.replace(/\/$/, "").split("/");
      if (
        !entry.name ||
        entry.name.includes("\\") ||
        entry.name.includes("\0") ||
        parts.some((p) => !p || p === "." || p === "..") ||
        /^[A-Za-z]:/.test(entry.name)
      )
        throw new Error(`Unsafe backup path: ${entry.name}`);
      expanded += entry.originalSize;
      if (
        entry.originalSize > 512 * 1024 * 1024 ||
        expanded > 1024 * 1024 * 1024
      )
        throw new Error(
          "Backup exceeds the preflight limit (512 MiB per entry, 1 GiB total)",
        );
      return true;
    },
  });
  if (!files["workspace.sqlite"])
    throw new Error("Backup is missing workspace.sqlite");
  for (const [name, bytes] of Object.entries(files)) {
    if (name.endsWith("/"))
      mkdirSync(path.join(directory, name), { recursive: true, mode: 0o700 });
    else atomicWrite(path.join(directory, name), bytes);
  }
  // Archives without referenced objects may legitimately have no objects entries.
  mkdirSync(path.join(directory, "objects"), { recursive: true, mode: 0o700 });
}

export function verifyBackup(archive: Uint8Array) {
  const directory = mkdtempSync(
    path.join(os.tmpdir(), "fieldwork-backup-verify-"),
  );
  try {
    extractBackup(archive, directory);
    const store = new Store(directory, directory, { readOnly: true });
    try {
      const checks = store.db.prepare("PRAGMA quick_check").all();
      if (checks.some((row) => row.quick_check !== "ok"))
        throw new Error("SQLite integrity check failed");
      return inspectBackupIntegrity(store);
    } finally {
      store.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
