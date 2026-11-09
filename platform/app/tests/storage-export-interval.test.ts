import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { Store } from "../server/storage.js";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { card } from "./fixtures/greenhouse-pull-fixture.js";
import type { PullRun } from "../server/greenhouse-pull-records.js";

const read = (store: Store) =>
  readFileSync(path.join(store.dataDir, "personal-export.json"), "utf8");
const run = (status: PullRun["status"] = "running"): PullRun => ({
  id: "run",
  target: 10,
  clientRequestId: "test",
  status,
  phase: "Test progress",
  queryIndex: 0,
  page: 1,
  cutoff: new Date().toISOString(),
  pages: [],
  failures: [],
  limitCount: 0,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

for (const explicit of [false, true])
  test(`${explicit ? "explicit" : "automatic"} completion starts a ten-minute minimum interval`, (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
    const f = applicationAnswerFixture();
    try {
      f.store.autoExport();
      if (explicit) f.store.flushExport();
      else t.mock.timers.tick(2000);
      const before = read(f.store);
      for (let i = 0; i < 599; i++) {
        f.store.put("personal", "one", { id: "one", version: i });
        f.store.autoExport();
        t.mock.timers.tick(1000);
      }
      assert.equal(read(f.store), before);
      // A last-second write cannot postpone the already requested interval boundary.
      f.store.put("personal", "one", { id: "one", version: 600 });
      f.store.autoExport();
      t.mock.timers.tick(999);
      assert.equal(read(f.store), before);
      t.mock.timers.tick(1);
      assert.equal(JSON.parse(read(f.store)).records.personal[0].version, 600);
      t.mock.timers.tick(600000);
      f.store.put("personal", "one", { id: "one", version: 601 });
      f.store.autoExport();
      const quiet = read(f.store);
      t.mock.timers.tick(1999);
      assert.equal(read(f.store), quiet);
      t.mock.timers.tick(1);
      assert.equal(JSON.parse(read(f.store)).records.personal[0].version, 601);
    } finally {
      f.cleanup();
    }
  });

test("pull progress alone never schedules; mixed writes include all dirty records and shutdown saves progress", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
  const f = applicationAnswerFixture();
  try {
    f.store.flushExport();
    const before = read(f.store);
    f.store.put("greenhouse_pull_run", "run", run());
    for (let i = 0; i < 12; i++) {
      f.store.put("greenhouse_pull_candidate", "candidate", {
        id: "candidate",
        runId: "run",
        state: "discovered",
        card: card(String(i)),
      });
      f.store.put("greenhouse_pull_run", "run", { ...run(), page: i + 1 });
      f.store.autoExport();
      t.mock.timers.tick(600000);
    }
    assert.equal(read(f.store), before);
    f.store.put("personal", "one", { id: "one", version: 1 });
    f.store.autoExport();
    t.mock.timers.tick(2000);
    assert.equal(
      read(f.store),
      JSON.stringify(f.store.personalExport(), null, 2),
    );
    f.store.remove("greenhouse_pull_candidate", "candidate");
    f.store.put("greenhouse_pull_run", "run", { ...run(), page: 99 });
    f.store.close();
    const saved = JSON.parse(read(f.store));
    assert.equal(saved.records.greenhouse_pull_run[0].page, 99);
    assert.deepEqual(saved.records.greenhouse_pull_candidate, []);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a terminal pull transition requests an export but repeated terminal activity does not", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
  const f = applicationAnswerFixture();
  try {
    f.store.put("greenhouse_pull_run", "run", run());
    f.store.flushExport();
    f.store.put("greenhouse_pull_run", "run", run("exhausted"));
    f.store.autoExport();
    t.mock.timers.tick(600000);
    assert.equal(
      JSON.parse(read(f.store)).records.greenhouse_pull_run[0].status,
      "exhausted",
    );
    const before = read(f.store);
    f.store.put("greenhouse_pull_run", "run", {
      ...run("exhausted"),
      phase: "Late activity",
    });
    f.store.autoExport();
    t.mock.timers.tick(3600000);
    assert.equal(read(f.store), before);
  } finally {
    f.cleanup();
  }
});

test("rolled-back writes do not request exports, and bulk SQL updates and deletes are included", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
  const f = applicationAnswerFixture();
  try {
    f.store.flushExport();
    const before = read(f.store);
    assert.throws(
      () =>
        f.store.transaction(() => {
          f.store.put("personal", "one", { id: "one", version: 1 });
          f.store.autoExport();
          throw Error("rollback");
        }),
      /rollback/,
    );
    f.store.autoExport();
    t.mock.timers.tick(600000);
    assert.equal(read(f.store), before);
    f.store.db.exec(
      "UPDATE records SET json=json_set(json, '$.version', 9) WHERE kind='settings'; DELETE FROM records WHERE kind='task'",
    );
    f.store.autoExport();
    t.mock.timers.tick(2000);
    assert.equal(
      read(f.store),
      JSON.stringify(f.store.personalExport(), null, 2),
    );
  } finally {
    f.cleanup();
  }
});

test("restart honors the completed export interval and explicit flush remains immediate", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const f = applicationAnswerFixture();
  f.store.flushExport();
  f.store.close();
  const store = new Store(f.root, f.store.dataDir);
  try {
    const before = read(store);
    store.put("personal", "one", { id: "one", version: 1 });
    store.autoExport();
    t.mock.timers.tick(2000);
    assert.equal(read(store), before);
    store.flushExport();
    assert.equal(JSON.parse(read(store)).records.personal[0].version, 1);
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
