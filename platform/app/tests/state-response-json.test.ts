import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { stateResponseJson } from "../server/state-response-json.js";
import { clientTaskSummaries } from "../server/client-task-summary.js";
import { documentsWithWritingWarnings } from "../server/document-writing-status.js";
import { followUpSummaries } from "../server/follow-up-email.js";
import { currentResumePath } from "../server/application-evidence.js";
import { withReadCache } from "../server/storage-read-cache.js";
import type { Store } from "../server/storage.js";
import type { AppState } from "../shared/types.js";
import { stateCacheFixture, seedStateCache } from "./fixtures/state-cache.js";
import { uncachedState } from "./fixtures/uncached-state.js";
import { legacyTask } from "./fixtures/legacy-records.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

function originalResponse(store: Store, runtime: AppState) {
  return withReadCache(store, () => {
    const snapshot = uncachedState(store);
    return JSON.stringify({
      ...snapshot,
      knownSkills: runtime.knownSkills,
      openingFormChecks: runtime.openingFormChecks,
      tasks: clientTaskSummaries(snapshot.tasks),
      documents: documentsWithWritingWarnings(
        store,
        snapshot.documents,
        snapshot.tasks,
      ),
      followUps: followUpSummaries(store),
      preparations: runtime.preparations,
      openingAutofillFinishCounts: runtime.openingAutofillFinishCounts,
      openingAutofillAnswerCounts: runtime.openingAutofillAnswerCounts,
      greenhousePull: runtime.greenhousePull,
      openingValidation: runtime.openingValidation,
      indexing: runtime.indexing,
      reindexProgress: runtime.reindexProgress,
    });
  });
}

test("assembled JSON is byte-identical for populated state, overwritten keys, Unicode and omissions", () => {
  const f = stateCacheFixture();
  try {
    const meta = f.store.get("meta", "import");
    assert.ok(meta);
    // Historical import JSON can carry additional fields before regular state keys.
    const historicalMeta = {
      ...meta,
      "10": "ten",
      "2": "two",
      knownSkills: ["old"],
      reindexProgress: "old",
    };
    f.store.put("meta", "import", historicalMeta);
    const live = {
      knownSkills: ["React"],
      documents: [
        {
          ...f.store.state().documents[0],
          writingWarning: 'Changed "rules"\n保留',
        },
      ],
      reindexProgress: undefined,
      indexing: false,
      extra: { missing: undefined, empty: null, array: [undefined, "\ud800"] },
    };
    for (let i = 0; i < 3; i++) {
      const snapshot = f.store.state();
      const expected = {
        ...uncachedState(f.store),
        ...live,
        tasks: clientTaskSummaries(snapshot.tasks),
      };
      assert.equal(stateResponseJson(snapshot, live), JSON.stringify(expected));
      const parsed = JSON.parse(stateResponseJson(snapshot, live));
      assert.equal(parsed.tasks[0].posting?.text, undefined);
      assert.equal(snapshot.tasks[0].posting?.text, "Full posting body");
      const task = f.store.get("task", "task");
      assert.ok(task);
      f.store.put("task", "task", { ...task, liveText: `Progress ${i}` });
    }
    f.store.remove("task", "task");
    f.store.put("task", "new", legacyTask({ id: "new", liveText: "New" }));
    const state = f.store.state();
    assert.equal(
      stateResponseJson(state, {}),
      JSON.stringify({
        ...uncachedState(f.store),
        tasks: clientTaskSummaries(state.tasks),
      }),
    );
  } finally {
    f.close();
  }
});

test("only a changed task's client summary is serialized again", (t) => {
  const f = stateCacheFixture();
  try {
    f.store.put("task", "second", legacyTask({ id: "second" }));
    stateResponseJson(f.store.state(), {});
    const stringify = JSON.stringify;
    const serialized: string[] = [];
    t.mock.method(
      JSON,
      "stringify",
      (...args: Parameters<typeof stringify>) => {
        const value = args[0];
        if (value && typeof value === "object" && "id" in value)
          serialized.push(String(value.id));
        return stringify(...args);
      },
    );
    stateResponseJson(f.store.state(), {});
    assert.deepEqual(serialized, []);
    f.store.put(
      "task",
      "second",
      legacyTask({ id: "second", liveText: "Changed" }),
    );
    serialized.length = 0;
    stateResponseJson(f.store.state(), {});
    assert.deepEqual(serialized, ["second"]);
    const before = stateResponseJson(f.store.state(), {});
    assert.throws(
      () =>
        f.store.transaction(() => {
          f.store.remove("task", "task");
          assert.notEqual(stateResponseJson(f.store.state(), {}), before);
          throw new Error("rollback");
        }),
      /rollback/,
    );
    assert.equal(stateResponseJson(f.store.state(), {}), before);
  } finally {
    f.close();
  }
});

test("runtime values are serialized fresh even when shallow-frozen or reused by the caller", () => {
  const f = stateCacheFixture();
  try {
    const runtime = Object.freeze({ progress: { completed: 0 } });
    const snapshot = f.store.state();
    assert.equal(
      JSON.parse(stateResponseJson(snapshot, { runtime })).runtime.progress
        .completed,
      0,
    );
    runtime.progress.completed = 9;
    assert.equal(
      JSON.parse(stateResponseJson(snapshot, { runtime })).runtime.progress
        .completed,
      9,
    );
  } finally {
    f.close();
  }
});

test("HTTP state bytes match the original route and remain fresh without record writes", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-state-json-"));
  mkdirSync(path.dirname(path.join(root, currentResumePath)), {
    recursive: true,
  });
  writeFileSync(path.join(root, currentResumePath), "React");
  const workspace = await openFixtureWorkspace(root);
  try {
    seedStateCache(workspace.store);
    let clock = Date.now();
    t.mock.method(Date, "now", () => clock);
    workspace.store.put("application_follow_up", "follow-up", {
      id: "follow-up",
      applicationId: "application",
      openingId: "custom-opening",
      version: 1,
      createdAt: new Date(clock).toISOString(),
      updatedAt: new Date(clock).toISOString(),
      history: [],
      sent: [],
      testSends: [],
      generation: {
        kind: "generate",
        status: "requested",
        requestId: "request",
        startedAt: new Date(clock).toISOString(),
      },
    });
    const read = async () => {
      const response = await workspace.get("/api/state");
      assert.equal(response.status, 200);
      const text = await response.text();
      const state = JSON.parse(text) as AppState;
      assert.equal(text, originalResponse(workspace.store, state));
      return state;
    };
    const before = await read();
    assert.ok(before.knownSkills?.includes("React"));
    assert.equal(before.followUps?.[0].generation?.status, "drafting");
    writeFileSync(path.join(root, currentResumePath), "PostgreSQL and Python");
    clock += 10 * 60_000;
    const after = await read();
    assert.ok(after.knownSkills?.includes("Python"));
    assert.ok(!after.knownSkills?.includes("React"));
    assert.equal(after.followUps?.[0].generation?.status, "failed");
    workspace.store.put(
      "task",
      "new",
      legacyTask({ id: "new", liveText: "New task" }),
    );
    await read();
    workspace.store.remove("custom_opening", "custom-opening");
    await read();
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});
