import test from "node:test";
import assert from "node:assert/strict";
import { legacyBundle, legacyTask } from "./fixtures/legacy-records.js";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  rmSync,
  unlinkSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store, sha256 } from "../server/storage.js";
import {
  draftPath,
  collectArtifacts,
  writeDraftArtifact,
} from "../server/bundles.js";
const id = "00000000-0000-0000-0000-000000000001";

function fixture() {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "fieldwork-file-boundaries-"),
  );
  const dataDir = path.join(root, ".data");
  const store = new Store(root, dataDir);
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "marker.md"), "SAFE_FIXTURE_OUTSIDE");
  const drafts = path.join(store.dataDir, "drafts");
  mkdirSync(drafts);
  return {
    root,
    dataDir: store.dataDir,
    store,
    outside,
    drafts,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("draft resolution rejects traversal, an external bundle-root symlink and symlinked drafts directory", () => {
  const f = fixture();
  try {
    assert.throws(
      () => draftPath(f.store, id, "../outside/marker.md"),
      /Invalid draft path/,
    );
    symlinkSync(f.outside, path.join(f.drafts, id));
    assert.throws(() => draftPath(f.store, id, "marker.md"), /symlink/);
    assert.throws(() => collectArtifacts(f.store, id), /symlink/);
    unlinkSync(path.join(f.drafts, id));
    rmSync(f.drafts, { recursive: true });
    symlinkSync(f.outside, f.drafts);
    assert.throws(() => draftPath(f.store, id, "marker.md"), /symlink/);
    assert.equal(
      readFileSync(path.join(f.outside, "marker.md"), "utf8"),
      "SAFE_FIXTURE_OUTSIDE",
    );
  } finally {
    f.close();
  }
});

test("draft resolution also rejects internal and dangling symlinks, collector omits linked artifacts", () => {
  const f = fixture();
  try {
    const base = path.join(f.drafts, id);
    mkdirSync(base);
    writeFileSync(path.join(base, "real.md"), "Safe artifact");
    symlinkSync(path.join(base, "real.md"), path.join(base, "inside.md"));
    symlinkSync(
      path.join(f.outside, "missing"),
      path.join(base, "dangling.md"),
    );
    assert.throws(() => draftPath(f.store, id, "inside.md"), /symlink/);
    assert.throws(() => draftPath(f.store, id, "dangling.md"), /symlink/);
    assert.deepEqual(
      collectArtifacts(f.store, id).map((a) => a.path),
      ["real.md"],
    );
  } finally {
    f.close();
  }
});

test("object storage rejects symlinked object directory, object leaves and replaced data anchor", () => {
  const f = fixture();
  const hash = "a".repeat(64);
  try {
    const objects = path.join(f.dataDir, "objects");
    rmSync(objects, { recursive: true });
    symlinkSync(f.outside, objects);
    writeFileSync(path.join(f.outside, hash), "SAFE_FIXTURE_OBJECT_OUTSIDE");
    assert.throws(() => f.store.objectPath(hash), /symlink/);
    unlinkSync(objects);
    mkdirSync(objects);
    symlinkSync(path.join(f.outside, hash), path.join(objects, hash));
    assert.throws(() => f.store.objectPath(hash), /symlink/);
    rmSync(path.join(objects, hash));
    const moved = path.join(f.root, "moved-data");
    renameSync(f.dataDir, moved);
    symlinkSync(moved, f.dataDir);
    assert.throws(() => f.store.objectPath(hash), /symlink/);
    assert.throws(() => draftPath(f.store, id), /anchor changed/);
    unlinkSync(f.dataDir);
    renameSync(moved, f.dataDir);
  } finally {
    f.close();
  }
});

test("editing a validated draft invalidates both bundle and task projection and refreshes artifact hash", () => {
  const f = fixture();
  try {
    const base = path.join(f.drafts, id);
    mkdirSync(base);
    writeFileSync(path.join(base, "resume.md"), "Original draft");
    const bundle = {
      id,
      version: 2,
      status: "validated",
      validation: { status: "passed" },
      artifacts: [],
    };
    f.store.put("bundle", id, legacyBundle(bundle));
    f.store.put("task", id, legacyTask({ id, version: 4, bundle }));
    const result = writeDraftArtifact(
      f.store,
      id,
      "resume.md",
      sha256("Original draft"),
      "Edited draft",
    );
    const updated = f.store.get("bundle", id)!;
    const task = f.store.get("task", id)!;
    assert.equal(updated.status, "draft");
    assert.equal(updated.validation, null);
    assert.equal(updated.version, 3);
    assert.deepEqual(task.bundle, updated);
    assert.equal(task.version, 5);
    assert.equal(
      updated.artifacts!.find((a: any) => a.path === "resume.md")!.hash,
      result.hash,
    );
    f.store.flushExport();
    const exported = JSON.parse(
      readFileSync(path.join(f.dataDir, "personal-export.json"), "utf8"),
    );
    assert.equal(exported.records.task[0].bundle.validation, null);
    writeFileSync(path.join(base, "resume.md"), "Concurrent external revision");
    assert.throws(
      () =>
        writeDraftArtifact(
          f.store,
          id,
          "resume.md",
          result.hash,
          "Stale browser text",
        ),
      /External edit/,
    );
    assert.equal(
      readFileSync(path.join(base, "resume.md"), "utf8"),
      "Concurrent external revision",
    );
  } finally {
    f.close();
  }
});
