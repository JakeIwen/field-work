import test from "node:test";
import { once } from "node:events";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { publicCareersFetch } from "../server/careers/http.js";
import { CodexModelCatalog } from "../server/codex-model-catalog.js";
import { ClaudeModelCatalog } from "../server/claude-code/models.js";
import { activityLog } from "../server/activity-log.js";
import { onStateCacheInvalidation } from "../server/storage-state-cache.js";
import { catalogRecords } from "../server/record-catalog.js";
import { tunableValue, type TunableSettings } from "../shared/tunables.js";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";

test("careers HTTP timeout reads the current override on every request", async (t) => {
  const durations: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    durations.push(ms);
    return AbortSignal.abort(new Error("test timeout"));
  });
  const settings: TunableSettings = {};
  const read = () =>
    publicCareersFetch(
      "https://example.com/careers",
      new AbortController().signal,
      undefined,
      () => settings,
    );
  await assert.rejects(read(), /test timeout/);
  settings.tunables = { "careers.httpTimeoutS": 7 };
  await assert.rejects(read(), /test timeout/);
  assert.deepEqual(durations, [20000, 7000]);
});

test("both model catalogs decide staleness using live cache and retry overrides", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1791600000000 });
  const settings: TunableSettings = {};
  let failing = false;
  const check = () => {
    if (failing) throw new Error("offline");
  };
  const read = (key: Parameters<typeof tunableValue>[1]) =>
    tunableValue(settings, key);
  const catalogs = [
    new CodexModelCatalog(async () => {
      check();
      return {
        data: [
          {
            id: "test",
            model: "test",
            displayName: "test",
            isDefault: true,
            defaultReasoningEffort: "high",
            supportedReasoningEfforts: [{ reasoningEffort: "high" }],
          },
        ],
      };
    }, read),
    new ClaudeModelCatalog(async () => {
      check();
      return [
        {
          value: "claude-opus-5-5",
          displayName: "Opus",
          description: "Test",
          supportedEffortLevels: ["high"],
        },
      ];
    }, read),
  ];
  await Promise.all(catalogs.map((catalog) => catalog.refresh()));
  t.mock.timers.tick(60000);
  assert.ok(catalogs.every((catalog) => !catalog.refreshDue));
  settings.tunables = {
    "models.catalogCacheMin": 1,
    "models.catalogRetryS": 600,
  };
  assert.ok(catalogs.every((catalog) => catalog.refreshDue));
  failing = true;
  for (const catalog of catalogs)
    await assert.rejects(catalog.refresh(), /offline/);
  t.mock.timers.tick(60000);
  assert.ok(catalogs.every((catalog) => !catalog.refreshDue));
  settings.tunables["models.catalogRetryS"] = 60;
  assert.ok(catalogs.every((catalog) => catalog.refreshDue));
});

test("the activity page size setting is the default page and the request maximum is fixed", () => {
  const f = applicationAnswerFixture();
  try {
    for (let i = 0; i < 25; i++) f.store.journal("test", `entry ${i}`);
    assert.equal(activityLog(f.store, {}).entries.length, 25);
    f.store.put("settings", "main", {
      ...f.store.settings(),
      tunables: { "records.activityPageSize": 10 },
    });
    // Omitting the limit uses the saved page size ...
    const page = activityLog(f.store, {});
    assert.equal(page.entries.length, 10);
    assert.ok(page.nextCursor);
    // ... and an explicit limit (what the client sends) is accepted up to the registry maximum.
    assert.equal(activityLog(f.store, { limit: 20 }).entries.length, 20);
    assert.equal(activityLog(f.store, { limit: 10 }).entries.length, 10);
    assert.throws(
      () => activityLog(f.store, { limit: 1001 }),
      /between 1 and 1000/,
    );
    f.store.put("settings", "main", {
      ...f.store.settings(),
      tunables: { "records.catalogPageSize": 10 },
    });
    assert.ok(catalogRecords(f.store, {}).rows.length <= 10);
    assert.throws(
      () => catalogRecords(f.store, { limit: 1001 }),
      /between 1 and 1000/,
    );
  } finally {
    f.cleanup();
  }
});

test("automatic exports honor the current minimum interval override", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
  const f = applicationAnswerFixture();
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      tunables: { "records.exportMinIntervalMin": 1 },
    });
    f.store.flushExport();
    const file = path.join(f.store.dataDir, "personal-export.json");
    const before = readFileSync(file, "utf8");
    f.store.put("personal", "one", { id: "one", version: 1, notes: "updated" });
    f.store.autoExport();
    t.mock.timers.tick(59999);
    assert.equal(readFileSync(file, "utf8"), before);
    t.mock.timers.tick(1);
    assert.equal(
      JSON.parse(readFileSync(file, "utf8")).records.personal[0].notes,
      "updated",
    );
  } finally {
    f.cleanup();
  }
});

test("a pending export is rescheduled from the live timing after a save", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
  const f = applicationAnswerFixture();
  try {
    f.store.flushExport();
    const file = path.join(f.store.dataDir, "personal-export.json");
    const before = readFileSync(file, "utf8");
    f.store.put("personal", "one", { id: "one", version: 1, notes: "updated" });
    f.store.autoExport();
    // Armed for the default ten-minute minimum interval.
    f.store.put("settings", "main", {
      ...f.store.settings(),
      tunables: { "records.exportMinIntervalMin": 1 },
    });
    f.store.rescheduleExport();
    t.mock.timers.tick(59999);
    assert.equal(readFileSync(file, "utf8"), before);
    t.mock.timers.tick(1);
    assert.equal(
      JSON.parse(readFileSync(file, "utf8")).records.personal[0].notes,
      "updated",
    );
  } finally {
    f.cleanup();
  }
});

test("state-cache invalidation callbacks can be limited to the kinds they depend on", () => {
  const f = applicationAnswerFixture();
  let calls = 0;
  const stop = onStateCacheInvalidation(f.store, () => calls++, ["settings"]);
  try {
    f.store.put("personal", "one", { id: "one", version: 1, notes: "x" });
    assert.equal(calls, 0, "other record kinds never call back");
    f.store.put("settings", "main", { ...f.store.settings(), version: 99 });
    assert.equal(calls, 1);
    assert.throws(() =>
      f.store.transaction(() => {
        f.store.put("personal", "two", { id: "two", version: 1, notes: "y" });
        throw new Error("roll back");
      }),
    );
    assert.ok(calls >= 2, "a rollback may have changed anything");
  } finally {
    stop();
    f.cleanup();
  }
});

test("watcher timing updates rearm only the watcher and stop prevents later rearming", async () => {
  const { WorkspaceRuntime } =
    await import("../server/task-kinds/workspace-runtime.js");
  const { setTimeout: pause } = await import("node:timers/promises");
  const f = applicationAnswerFixture();
  const runtime = new WorkspaceRuntime({
    root: f.root,
    dataDir: path.join(f.root, "watcher-data"),
    port: 0,
    connectAgent: false,
  });
  try {
    runtime.startWatcher();
    const first = runtime.watcher;
    assert.ok(first);
    await once(first, "ready");
    runtime.store.put("settings", "main", {
      ...runtime.store.settings(),
      tunables: {
        "server.sourcePollMs": 500,
        "server.binaryPollMs": 1000,
        "server.fileStableMs": 1000,
        "server.fileStablePollMs": 100,
      },
    });
    for (let i = 0; runtime.watcher === first && i < 100; i++) await pause(5);
    const second = runtime.watcher;
    assert.ok(second && second !== first);
    assert.equal(first.closed, true);
    assert.equal(second.options.interval, 500);
    assert.equal(second.options.binaryInterval, 1000);
    assert.deepEqual(second.options.awaitWriteFinish, {
      stabilityThreshold: 1000,
      pollInterval: 100,
    });
    await runtime.stopWatcher();
    runtime.store.put("settings", "main", {
      ...runtime.store.settings(),
      tunables: { "server.sourcePollMs": 800 },
    });
    await pause(5);
    assert.equal(runtime.watcher, undefined);
  } finally {
    await runtime.stopWatcher();
    runtime.store.close();
    f.cleanup();
  }
});
