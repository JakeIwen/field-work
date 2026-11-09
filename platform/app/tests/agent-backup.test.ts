import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { Store } from "../server/storage.js";
import { createBackupArchive } from "../server/backup-archive.js";

test("backups retain both thread registries but never the Claude sign-in token", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "agent-backup-"));
  const dataDir = path.join(root, "data");
  const store = new Store(root, dataDir);
  try {
    const registry = JSON.stringify({ schemaVersion: 1, threads: {} });
    for (const name of ["codex-threads.json", "claude-threads.json"])
      writeFileSync(path.join(dataDir, name), registry);
    writeFileSync(
      path.join(dataDir, "claude-code-token"),
      "fixture-not-a-token",
    );
    const files = unzipSync(createBackupArchive(store).bytes);
    assert.equal(strFromU8(files["claude-threads.json"]), registry);
    assert.equal(strFromU8(files["codex-threads.json"]), registry);
    assert.equal(files["claude-code-token"], undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
