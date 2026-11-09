import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Store } from "../server/storage.js";
import { ApplicationPreparationManager } from "../server/application-preparation.js";
import { legacyOpening, legacyTask } from "./fixtures/legacy-records.js";

function fixture(count: number) {
  const root = mkdtempSync(path.join(os.tmpdir(), "preparation-concurrency-"));
  const store = new Store(root, path.join(root, ".local/data"));
  const openings = Array.from({ length: count }, (_, index) =>
    String(index + 1),
  );
  for (const id of openings)
    store.put(
      "cache_opening",
      id,
      legacyOpening({
        id,
        url: `https://job-boards.greenhouse.io/example/jobs/${id}`,
        hash: id,
      }),
    );
  const manager = new ApplicationPreparationManager(store, {
    changed() {},
    async generateScript(openingId) {
      return { id: `script-${openingId}` };
    },
    async createDocuments(run, preset) {
      assert.equal(preset, "posting-application");
      const task = legacyTask({
        id: `task-${run.openingId}`,
        preset,
        status: "running",
        threadId: `thread-${run.openingId}`,
        context: { openingId: run.openingId },
      });
      store.put("task", task.id, task);
      return task;
    },
    async startTask() {
      throw new Error("Fixture tasks already run");
    },
    async startAnswers() {
      throw new Error("Fixture documents are still running");
    },
  });
  return {
    store,
    manager,
    openings,
    async close() {
      await manager.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("unset preparation concurrency starts eight Openings and leaves a ninth queued", async () => {
  const f = fixture(9);
  try {
    for (const id of f.openings) f.manager.start(id);
    for (let i = 0; i < 4; i++) await f.manager.tick();
    assert.equal(f.store.list("task").length, 8);
    assert.equal(
      f.manager.state().filter((run) => run.status === "running").length,
      8,
    );
    assert.equal(f.manager.latest("9")?.status, "queued");
  } finally {
    await f.close();
  }
});

test("live preparation limits hold new starts, wake queued work and never freeze or interrupt admitted runs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(4);
  const saveLimit = (parallelPreparations: number) => {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      parallelPreparations,
    });
  };
  try {
    saveLimit(2);
    for (const id of f.openings) f.manager.start(id);
    for (let i = 0; i < 4; i++) await f.manager.tick();
    assert.equal(f.store.list("task").length, 2);
    assert.equal(f.manager.latest("3")?.status, "queued");
    t.mock.timers.tick(0);
    await setImmediate();
    saveLimit(3);
    f.manager.wake();
    t.mock.timers.tick(0);
    await setImmediate();
    assert.equal(
      f.manager.latest("3")?.status,
      "running",
      "wake admits queued work without waiting for the one-second poll",
    );
    assert.equal(f.manager.latest("3")?.phase, "form");
    saveLimit(1);
    for (let i = 0; i < 3; i++) await f.manager.tick();
    assert.equal(
      f.manager.latest("3")?.phase,
      "documents",
      "admitted work continues through later stages above the new limit",
    );
    assert.equal(f.store.list("task").length, 3);
    assert.ok(f.store.list("task").every((task) => task.status === "running"));
    assert.ok(
      f.manager
        .state()
        .filter((run) => run.openingId !== "4")
        .every((run) => run.status === "running"),
    );
    assert.equal(f.manager.latest("4")?.status, "queued");
    for (const task of f.store.list("task").slice(0, 2))
      f.store.put("task", task.id, {
        ...task,
        status: "failed",
        error: "Fixture task ended",
      });
    for (let i = 0; i < 2; i++) await f.manager.tick();
    assert.equal(
      f.manager.latest("4")?.status,
      "queued",
      "one running preparation still occupies the lowered limit",
    );
    const last = f.store.get("task", "task-3");
    assert.ok(last);
    f.store.put("task", last.id, {
      ...last,
      status: "failed",
      error: "Fixture task ended",
    });
    for (let i = 0; i < 2; i++) await f.manager.tick();
    assert.equal(f.manager.latest("4")?.status, "running");
  } finally {
    await f.close();
  }
});
