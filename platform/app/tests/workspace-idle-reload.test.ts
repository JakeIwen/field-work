import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceReloader } from "../server/workspace-reload.js";
import {
  hasActiveTaskWork,
  remainingTaskWork,
} from "../server/workspace-activity.js";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { legacyTask } from "./fixtures/legacy-records.js";
import { assertGenerationActive } from "../server/generation-control.js";
import type { ReloadWorkItem } from "../shared/app-reload.js";

function fixture() {
  const f = applicationAnswerFixture();
  let items: ReloadWorkItem[] = [
    { id: "task", label: "Writing answers", detail: "running" },
  ];
  let stopped = 0,
    interrupted = 0,
    quiesced = 0;
  const reloader = new WorkspaceReloader({
    store: f.store,
    supported: () => true,
    remainingWork: () => items,
    activeThreadIds: () => (items.length ? ["thread"] : []),
    interrupt: async () => {
      interrupted++;
    },
    quiesce: async () => {
      quiesced++;
    },
    drainRequests: async () => {},
    shutdown: () => {
      stopped++;
    },
  });
  return {
    ...f,
    reloader,
    items: (value: ReloadWorkItem[]) => {
      items = value;
    },
    counts: () => ({ stopped, interrupted, quiesced }),
    cleanup: () => {
      reloader.close();
      f.cleanup();
    },
  };
}

test("idle reload updates progress without stopping work, then reloads only when empty", async () => {
  const f = fixture();
  try {
    const first = f.reloader.request(true);
    assert.equal(first.waiting, true);
    assert.equal(first.reloading, false);
    assert.deepEqual(f.counts(), { stopped: 0, interrupted: 0, quiesced: 0 });
    assert.doesNotThrow(() => assertGenerationActive(f.store));
    f.items([{ id: "task", label: "Writing answers", detail: "saving" }]);
    f.reloader.checkIdle();
    assert.equal(f.reloader.status().remaining[0].detail, "saving");
    const task = f.store.get("task", "task");
    assert.ok(task);
    f.store.put("task", "task", { ...task, status: "completed" });
    f.items([]);
    f.reloader.checkIdle();
    await f.reloader.completion;
    assert.deepEqual(f.counts(), { stopped: 1, interrupted: 0, quiesced: 1 });
    assert.equal(f.store.get("task", "task")?.status, "completed");
  } finally {
    f.cleanup();
  }
});

test("cancellation clears pending status and cannot trigger a later restart", () => {
  const f = fixture();
  try {
    f.reloader.request(true);
    f.reloader.request(true);
    assert.equal(f.reloader.cancel().waiting, false);
    assert.deepEqual(f.reloader.status().remaining, []);
    f.items([]);
    f.reloader.checkIdle();
    assert.deepEqual(f.counts(), { stopped: 0, interrupted: 0, quiesced: 0 });
    assert.doesNotThrow(() => assertGenerationActive(f.store));
  } finally {
    f.cleanup();
  }
});

test("immediate reload can replace a queued reload", async () => {
  const f = fixture();
  try {
    f.reloader.request(true);
    f.reloader.request();
    await f.reloader.completion;
    assert.equal(f.reloader.status().waiting, false);
    assert.equal(f.counts().stopped, 1);
    assert.ok(f.counts().interrupted > 0);
  } finally {
    f.cleanup();
  }
});

test("remaining work includes waiting tasks and completed turns still rendering or saving", () => {
  const f = applicationAnswerFixture();
  try {
    f.store.put(
      "task",
      "waiting",
      legacyTask({ id: "waiting", status: "waiting for input" }),
    );
    f.store.put(
      "task",
      "rendering",
      legacyTask({
        id: "rendering",
        status: "completed",
        documentResult: { status: "rendering" },
      }),
    );
    f.store.put(
      "task",
      "saving",
      legacyTask({
        id: "saving",
        status: "completed",
        autofillResult: { status: "saving" },
      }),
    );
    f.store.put(
      "task",
      "done",
      legacyTask({ id: "done", status: "completed" }),
    );
    assert.deepEqual(
      remainingTaskWork(f.store)
        .map((item) => item.id)
        .sort(),
      ["task:task", "task:waiting", "task:rendering", "task:saving"].sort(),
    );
  } finally {
    f.cleanup();
  }
});

test("active task checks use status projections without loading task summaries", () => {
  const f = applicationAnswerFixture();
  try {
    f.store.taskSummaries = () => {
      throw Error("task summaries should not be loaded");
    };
    const existing = f.store.get("task", "task")!;
    f.store.put("task", "task", { ...existing, status: "completed" });
    assert.equal(hasActiveTaskWork(f.store), false);

    const activeRecords = [
      legacyTask({ id: "waiting", status: "waiting for input" }),
      legacyTask({
        id: "rendering",
        status: "completed",
        documentResult: { status: "rendering" },
      }),
      legacyTask({
        id: "saving",
        status: "completed",
        autofillResult: { status: "saving" },
      }),
    ];
    for (const record of activeRecords) {
      f.store.put("task", record.id, record);
      assert.equal(hasActiveTaskWork(f.store), true, record.id);
      f.store.remove("task", record.id);
      assert.equal(hasActiveTaskWork(f.store), false, record.id);
    }
  } finally {
    f.cleanup();
  }
});
