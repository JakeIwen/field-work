import { WorkspaceReloader } from "../server/workspace-reload.js";
import { blockPersonalExport } from "./fixtures/export-writer.js";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

const exported = (dataDir: string) =>
  JSON.parse(readFileSync(path.join(dataDir, "personal-export.json"), "utf8"));

test("personal export is deferred and a burst produces one latest snapshot", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
  const f = applicationAnswerFixture();
  let snapshots = 0;
  const snapshot = f.store.flushExport.bind(f.store);
  t.mock.method(f.store, "flushExport", () => {
    snapshots++;
    return snapshot();
  });
  try {
    for (let i = 0; i < 5; i++) {
      f.store.put("personal", "one", {
        id: "one",
        version: i,
        notes: String(i),
      });
      f.store.autoExport();
      t.mock.timers.tick(100);
    }
    assert.equal(snapshots, 0);
    assert.equal(
      existsSync(path.join(f.store.dataDir, "personal-export.json")),
      false,
    );
    t.mock.timers.tick(2000);
    assert.equal(snapshots, 1);
    assert.equal(exported(f.store.dataDir).records.personal[0].notes, "4");
  } finally {
    f.cleanup();
  }
});

test("continuous changes cannot postpone export beyond thirty seconds", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
  const f = applicationAnswerFixture();
  try {
    for (let i = 0; i < 30; i++) {
      f.store.put("personal", "one", { id: "one", version: i });
      f.store.autoExport();
      t.mock.timers.tick(1000);
    }
    assert.equal(exported(f.store.dataDir).records.personal[0].version, 29);
  } finally {
    f.cleanup();
  }
});

test("backup and Store close synchronously flush queued exports", () => {
  const f = applicationAnswerFixture();
  try {
    f.store.put("personal", "one", { id: "one", version: 1 });
    f.store.autoExport();
    f.store.backup();
    assert.equal(exported(f.store.dataDir).records.personal[0].version, 1);
    f.store.put("personal", "one", { id: "one", version: 2 });
    f.store.autoExport();
    f.store.close();
    assert.equal(exported(f.store.dataDir).records.personal[0].version, 2);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a failed deferred export is reported and retried without rejecting a committed mutation", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
  const f = applicationAnswerFixture();
  const unblock = blockPersonalExport(f.store);
  let errors = 0;
  t.mock.method(console, "error", () => {
    errors++;
  });
  try {
    f.store.put("personal", "one", { id: "one", version: 1 });
    assert.doesNotThrow(() => f.store.autoExport());
    assert.doesNotThrow(() => t.mock.timers.tick(2000));
    assert.equal(errors, 1);
    assert.equal(f.store.get("personal", "one")?.version, 1);
    unblock();
    t.mock.timers.tick(2000);
    assert.equal(exported(f.store.dataDir).records.personal[0].version, 1);
  } finally {
    f.cleanup();
  }
});

test("idle reload flushes pending edits without adding journal noise", async () => {
  const f = applicationAnswerFixture();
  f.store.remove("task", "task");
  f.store.put("personal", "one", {
    id: "one",
    version: 1,
    notes: "flush on reload",
  });
  let stopped = false;
  try {
    const reloader = new WorkspaceReloader({
      store: f.store,
      supported: () => true,
      activeThreadIds: () => [],
      interrupt: async () => {},
      quiesce: async () => {},
      drainRequests: async () => {},
      shutdown() {
        stopped = true;
        const snapshot = exported(f.store.dataDir);
        assert.equal(snapshot.records.personal[0].notes, "flush on reload");
        assert.equal(
          snapshot.records.journal.some(
            (entry: { type: string }) => entry.type === "app_reload",
          ),
          false,
        );
      },
    });
    reloader.request();
    await reloader.completion;
    assert.equal(stopped, true);
  } finally {
    f.cleanup();
  }
});

test("HTTP mutation acknowledges SQLite before exporting; workspace close flushes it", async () => {
  const f = applicationAnswerFixture();
  f.store.remove("cache_opening", "one");
  f.store.close();
  const workspace = await openFixtureWorkspace(f.root);
  try {
    workspace.store.flushExport();
    const before = exported(workspace.store.dataDir);
    const response = await workspace.post("/api/personal/one", {
      expectedVersion: 0,
      notes: "durable first",
    });
    assert.equal(response.status, 200);
    assert.equal(
      workspace.store.get("personal", "one")?.notes,
      "durable first",
    );
    assert.deepEqual(exported(workspace.store.dataDir), before);
    await workspace.close();
    assert.equal(
      exported(workspace.store.dataDir).records.personal[0].notes,
      "durable first",
    );
  } finally {
    await workspace.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
