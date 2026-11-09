import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { unzipSync, zipSync, strToU8 } from "fflate";
import { Store, atomicWrite, sha256 } from "../server/storage.js";
import { verifyBackup, extractBackup } from "../server/backup-verify.js";
import { referencedBackupObjects } from "../server/backup-integrity.js";
import { backupMaterialFixture } from "./fixtures/backup-materials.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

const platform = path.resolve(import.meta.dirname, "../..");
function cli(name: string, file: string, root: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", `app/scripts/${name}.ts`, file],
    {
      cwd: platform,
      encoding: "utf8",
      env: {
        ...process.env,
        JOB_SEARCH_ROOT: root,
        JOB_SEARCH_DATA: path.join(root, ".local/data"),
      },
    },
  );
}

async function download(f: Awaited<ReturnType<typeof backupMaterialFixture>>) {
  f.store.close();
  const workspace = await openFixtureWorkspace(f.root);
  try {
    const response = await workspace.get("/api/backup");
    assert.equal(response.status, 200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return {
      bytes,
      header: JSON.parse(response.headers.get("x-backup-integrity") ?? "null"),
      records: workspace.store.personalExport().records,
      hashes: Object.fromEntries(
        referencedBackupObjects(workspace.store)
          .filter((id) => {
            try {
              readFileSync(workspace.store.objectPath(id));
              return true;
            } catch {
              return false;
            }
          })
          .map((id) => [
            id,
            sha256(readFileSync(workspace.store.objectPath(id))),
          ]),
      ),
    };
  } finally {
    await workspace.close();
  }
}

test("G8: HTTP backup restores all material families and every referenced object byte", async () => {
  const f = await backupMaterialFixture();
  // This fixture has no orphan objects. Inventory it independently so an omitted
  // family in the shared backup/verification collector cannot make both pass.
  const fixtureObjects = readdirSync(path.join(f.store.dataDir, "objects"));
  const restoredDir = mkdtempSync(
    path.join(os.tmpdir(), "fieldwork-restored-"),
  );
  try {
    const { bytes, header, records, hashes } = await download(f);
    assert.equal(header.ok, true);
    const report = verifyBackup(bytes);
    assert.equal(report.ok, true);
    for (const kind of [
      "generated_document",
      "application_autofill",
      "application_answer_set",
      "application_answer_review",
      "application_preparation",
      "application",
      "opening_validation_run",
    ])
      assert.ok(report.counts[kind] > 0, kind);
    extractBackup(bytes, restoredDir);
    const restored = new Store(f.root, restoredDir);
    try {
      assert.deepEqual(restored.personalExport().records, records);
      for (const id of fixtureObjects)
        assert.equal(sha256(readFileSync(restored.objectPath(id))), id);
      assert.deepEqual(
        Object.fromEntries(
          referencedBackupObjects(restored).map((id) => [
            id,
            sha256(readFileSync(restored.objectPath(id))),
          ]),
        ),
        hashes,
      );
    } finally {
      restored.close();
    }
    const archive = path.join(f.root, "roundtrip.zip");
    atomicWrite(archive, bytes);
    const verification = cli("backup-verify", archive, f.root);
    assert.equal(verification.status, 0, verification.stderr);
    assert.deepEqual(JSON.parse(verification.stdout).integrity, report);
  } finally {
    rmSync(restoredDir, { recursive: true, force: true });
    rmSync(f.root, { recursive: true, force: true });
  }
});

for (const fault of ["missing", "corrupt"] as const) {
  test(`G8: ${fault} object is reported while HTTP and CLI still save a partial backup`, async () => {
    const f = await backupMaterialFixture();
    const id = f.script.scriptHash;
    if (fault === "missing") unlinkSync(f.store.objectPath(id));
    else atomicWrite(f.store.objectPath(id), "corrupted script bytes");
    try {
      const { bytes, header } = await download(f);
      const files = unzipSync(bytes);
      const summary = JSON.parse(
        Buffer.from(files["backup-integrity.json"]).toString(),
      );
      assert.equal(header.ok, false);
      assert.equal(header[fault === "missing" ? "missing" : "mismatched"], 1);
      const field =
        fault === "missing" ? "missingObjects" : "mismatchedObjects";
      assert.deepEqual(summary[field], [id]);
      assert.ok(files["workspace.sqlite"]);
      assert.equal(!!files[`objects/${id}`], fault === "corrupt");
      assert.deepEqual(verifyBackup(bytes)[field], [id]);
      // Verification recomputes integrity rather than trusting an embedded success claim.
      files["backup-integrity.json"] = strToU8('{"ok":true}');
      const archive = path.join(f.root, "partial.zip");
      atomicWrite(archive, zipSync(files));
      const check = cli("backup-verify", archive, f.root);
      assert.equal(check.status, 1, check.stderr);
      assert.deepEqual(JSON.parse(check.stdout).integrity[field], [id]);
      const target = path.join(f.root, "cli-backup.zip");
      const backup = cli("backup", target, f.root);
      assert.equal(backup.status, 1, backup.stderr);
      assert.deepEqual(JSON.parse(backup.stdout).integrity[field], [id]);
      assert.deepEqual(verifyBackup(readFileSync(target))[field], [id]);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });
}

test("backup retains objects referenced only by frozen package snapshots", async () => {
  const f = await backupMaterialFixture();
  try {
    const bytes = Buffer.from("%PDF-1.4\nHistorical package-only object");
    const hash = sha256(bytes);
    atomicWrite(f.store.objectPath(hash), bytes);
    const packages = f.application.packages;
    assert.ok(packages?.length);
    f.store.put("application", f.application.id, {
      ...f.application,
      packages: [
        {
          ...packages[0],
          documents: [
            ...packages[0].documents,
            { id: "historical", hash, name: "historical.pdf", format: "pdf" },
          ],
        },
      ],
    });
    const archive = f.store.backup();
    assert.deepEqual(Buffer.from(unzipSync(archive)[`objects/${hash}`]), bytes);
    assert.equal(verifyBackup(archive).ok, true);
  } finally {
    f.cleanup();
  }
});

test("preflight rejects unsafe paths and opens the restored database read-only", async () => {
  const f = await backupMaterialFixture();
  const directory = mkdtempSync(path.join(os.tmpdir(), "fieldwork-readonly-"));
  try {
    const bytes = f.store.backup();
    const files = unzipSync(bytes);
    files["../escape"] = strToU8("bad");
    assert.throws(
      () => extractBackup(zipSync(files), directory),
      /Unsafe backup path/,
    );
    extractBackup(bytes, directory);
    const database = path.join(directory, "workspace.sqlite");
    const before = sha256(readFileSync(database));
    const restored = new Store(directory, directory, { readOnly: true });
    try {
      assert.throws(
        () => restored.put("personal", "no", { id: "no", version: 0 }),
        /readonly/,
      );
    } finally {
      restored.close();
    }
    assert.equal(sha256(readFileSync(database)), before);
  } finally {
    f.cleanup();
    rmSync(directory, { recursive: true, force: true });
  }
});
