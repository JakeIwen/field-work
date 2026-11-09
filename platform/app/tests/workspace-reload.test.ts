import test from "node:test";
import assert from "node:assert/strict";
import { WorkspaceReloader } from "../server/workspace-reload.js";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { legacyTask } from "./fixtures/legacy-records.js";
import {
  handleTaskEvent,
  type TaskEventServices,
} from "../server/task-kinds/registry.js";
import {
  beginGeneration,
  assertGenerationActive,
} from "../server/generation-control.js";

function assertReloadInterruption(
  store: ReturnType<typeof applicationAnswerFixture>["store"],
) {
  const journal = store
    .list("journal")
    .find((entry) => entry.type === "app_reload");
  assert.match(
    journal?.message ?? "",
    /2 tasks; 1 preparations; 2 agent threads/,
  );
  assert.deepEqual(journal?.details, {
    interruptedTasks: 2,
    interruptedPreparations: 1,
    interruptedThreads: 2,
    interruptedGeneration: true,
    interruptedWork: [],
    unconfirmedInterrupts: 0,
  });
}

test("reload distinguishes interrupted workflows from normally drained work", async () => {
  for (const id of [
    "indexing",
    "follow-up-send",
    "saving",
    "preparation",
    "agent",
    "greenhouse",
    "careers",
    "validation",
    "gmail",
  ]) {
    const f = applicationAnswerFixture();
    f.store.remove("task", "task");
    try {
      const reloader = new WorkspaceReloader({
        store: f.store,
        supported: () => true,
        activeThreadIds: () => [],
        interrupt: async () => {},
        remainingWork: () => [{ id, label: id, detail: "Active" }],
        quiesce: async () => {},
        drainRequests: async () => {},
        shutdown: () => {},
      });
      reloader.request();
      await reloader.completion;
      const entry = f.store
        .list("journal")
        .find((item) => item.type === "app_reload");
      if (["greenhouse", "careers", "validation", "gmail"].includes(id))
        assert.match(entry?.message ?? "", new RegExp(id));
      else assert.equal(entry, undefined, id);
    } finally {
      f.cleanup();
    }
  }
});

test("reload interrupts active and late-starting turns, pauses preparation and waits for generation cleanup", async () => {
  const f = applicationAnswerFixture();
  const events: string[] = [];
  let threads = ["thread"],
    finish = () => {},
    stopped = 0;
  try {
    finish = beginGeneration(f.store);
    f.store.put(
      "task",
      "completed",
      legacyTask({ id: "completed", status: "completed" }),
    );
    f.store.put("application_preparation", "run", {
      id: "run",
      openingId: "one",
      applicationId: "app",
      status: "running",
      phase: "documents",
      message: "Generating",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      openingHash: "hash",
      documentIds: [],
      taskIds: ["task"],
      supportedForm: true,
    });
    const reloader = new WorkspaceReloader({
      store: f.store,
      supported: () => true,
      activeThreadIds: () => threads,
      interrupt: async (id) => {
        events.push(id);
        threads = threads.filter((t) => t !== id);
      },
      quiesce: async () => {
        assert.equal(
          f.store.get("application_preparation", "run")?.status,
          "paused",
        );
        finish();
      },
      drainRequests: async () => {
        assert.throws(() => assertGenerationActive(f.store), /Reload app/);
        threads.push("late-thread");
        f.store.put(
          "task",
          "late",
          legacyTask({
            id: "late",
            threadId: "late-thread",
            status: "running",
          }),
        );
      },
      shutdown: () => {
        stopped++;
      },
    });
    assert.equal(reloader.request().reloading, true);
    reloader.request();
    await reloader.completion;
    assert.equal(stopped, 1);
    assert.deepEqual(events, ["thread", "late-thread"]);
    assertReloadInterruption(f.store);
    assert.equal(f.store.get("task", "task")?.status, "interrupted");
    assert.equal(f.store.get("task", "late")?.status, "interrupted");
    assert.equal(f.store.get("task", "completed")?.status, "completed");
    assert.equal(
      f.store.get("application_preparation", "run")?.status,
      "paused",
    );
  } finally {
    finish();
    f.cleanup();
  }
});

test("failed interruption is recorded for reconciliation and deleted tasks are not restored", async () => {
  const f = applicationAnswerFixture();
  try {
    f.store.put(
      "task",
      "deleted",
      legacyTask({ id: "deleted", status: "running" }),
    );
    let stopped = false;
    const reloader = new WorkspaceReloader({
      store: f.store,
      supported: () => true,
      activeThreadIds: () => ["thread"],
      interrupt: async () => {
        throw new Error("Adapter unavailable");
      },
      quiesce: async () => {
        f.store.remove("task", "deleted");
      },
      drainRequests: async () => {},
      shutdown: () => {
        stopped = true;
      },
    });
    reloader.request();
    await reloader.completion;
    assert.equal(stopped, true);
    assert.equal(f.store.get("task", "task")?.status, "disconnected");
    assert.equal(f.store.get("task", "deleted"), undefined);
  } finally {
    f.cleanup();
  }
});

test("a workspace without a managed restart does not stop its work", () => {
  const f = applicationAnswerFixture();
  try {
    const reloader = new WorkspaceReloader({
      store: f.store,
      supported: () => false,
      activeThreadIds: () => [],
      interrupt: async () => {},
      quiesce: async () => {},
      drainRequests: async () => {},
      shutdown: () => assert.fail("must not stop"),
    });
    assert.throws(() => reloader.request(), /managed background service/);
    assert.equal(reloader.active, false);
    assert.doesNotThrow(() => assertGenerationActive(f.store));
  } finally {
    f.cleanup();
  }
});

test("late successful turn events during reload cannot start answer publication", () => {
  const f = applicationAnswerFixture();
  let publications = 0;
  try {
    const services: TaskEventServices = {
      store: f.store,
      stopping: () => true,
      publish() {},
      launchingTask: () => undefined,
      openingOperation: async (_key, work) => {
        publications++;
        return work();
      },
      generatePreparedAutofill: async () => ({ id: "unexpected" }),
    };
    handleTaskEvent(services, {
      method: "turn/completed",
      threadId: "thread",
      params: { turn: { id: "turn", status: "completed" } },
    });
    assert.equal(f.store.get("task", "task")?.status, "interrupted");
    assert.equal(publications, 0);
    assert.equal(f.store.list("application_answer_set").length, 0);
  } finally {
    f.cleanup();
  }
});
