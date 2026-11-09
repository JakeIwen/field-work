import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { preparationActivity } from "../server/preparation-activity.js";
import type { ApplicationPreparation } from "../shared/application-preparation.js";
import type { LiveTurnActivity } from "../shared/task-activity.js";
import type { Task } from "../shared/task-records.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { legacyOpening, legacyTask } from "./fixtures/legacy-records.js";

const live: LiveTurnActivity = {
  state: "thinking",
  since: "2026-11-06T10:00:00.000Z",
  lastSignalAt: "2026-11-06T10:01:00.000Z",
  outputChars: 0,
};
const run = {
  id: "run-1",
  openingId: "one",
  status: "running",
  phase: "documents",
  updatedAt: "2026-11-06T10:00:00.000Z",
  documentTaskId: "docs",
  answerTaskId: "answers",
  taskIds: [],
} as unknown as ApplicationPreparation;
const task = (id: string, status: string, threadId?: string) =>
  ({
    id,
    status,
    model: "claude-fable-5-1",
    effort: "xhigh",
    threadId,
  }) as Task;

test("preparationActivity returns live turns only for tasks with an active turn", () => {
  const tasks = new Map([
    ["docs", task("docs", "running", "t-docs")],
    ["answers", task("answers", "completed", "t-answers")],
  ]);
  const asked: string[] = [];
  const result = preparationActivity(
    {
      latestRecord: () => run,
      getTask: (id) => tasks.get(id),
      liveActivity: (threadId) => {
        asked.push(threadId);
        return live;
      },
    },
    "one",
  );
  assert.deepEqual(asked, ["t-docs"]);
  assert.equal(result.run?.phase, "documents");
  assert.deepEqual(
    result.tasks.map((t) => [t.role, t.status, t.live]),
    [
      ["documents", "running", live],
      ["answers", "completed", null],
    ],
  );
  assert.equal(result.tasks[0].model, "claude-fable-5-1");
});

test("preparationActivity skips missing tasks and reports no run", () => {
  const deps = {
    latestRecord: () => undefined,
    getTask: () => undefined,
    liveActivity: () => live,
  };
  assert.deepEqual(preparationActivity(deps, "one"), { run: null, tasks: [] });
  const noTasks = preparationActivity(
    { ...deps, latestRecord: () => run },
    "one",
  );
  assert.equal(noTasks.run?.id, "run-1");
  assert.deepEqual(noTasks.tasks, []);
});

test("GET /api/openings/:id/preparation/activity answers 404, null run and a run's tasks", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "prep-activity-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    assert.equal(
      (await workspace.get("/api/openings/missing/preparation/activity"))
        .status,
      404,
    );
    workspace.store.put(
      "cache_opening",
      "one",
      legacyOpening({ id: "one", url: "https://example.com/job" }),
    );
    const none = await workspace.get("/api/openings/one/preparation/activity");
    assert.equal(none.status, 200);
    assert.deepEqual(await none.json(), { run: null, tasks: [] });

    workspace.store.put(
      "task",
      "docs",
      legacyTask({
        id: "docs",
        preset: "posting-application",
        status: "running",
      }),
    );
    workspace.store.put("application_preparation", "run-1", {
      ...run,
      documentTaskId: "docs",
      answerTaskId: undefined,
    } as unknown as ApplicationPreparation);
    const body = await (
      await workspace.get("/api/openings/one/preparation/activity")
    ).json();
    assert.equal(body.run.id, "run-1");
    assert.equal(body.tasks.length, 1);
    assert.equal(body.tasks[0].role, "documents");
    assert.equal(body.tasks[0].live, null);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("GET /api/openings/:id/preparation/activity returns the agent's live view for the task's current thread", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "prep-activity-live-"));
  const workspace = await openFixtureWorkspace(root);
  const asked: string[] = [];
  mock.method(workspace.agent, "liveActivity", (threadId: string) => {
    asked.push(threadId);
    return live;
  });
  try {
    workspace.store.put(
      "cache_opening",
      "one",
      legacyOpening({ id: "one", url: "https://example.com/job" }),
    );
    workspace.store.put(
      "task",
      "docs",
      legacyTask({
        id: "docs",
        preset: "posting-application",
        status: "running",
        threadId: "thread-now",
        previousThreadIds: ["thread-before"],
      }),
    );
    workspace.store.put("application_preparation", "run-1", {
      ...run,
      documentTaskId: "docs",
      answerTaskId: undefined,
    } as unknown as ApplicationPreparation);
    const body = await (
      await workspace.get("/api/openings/one/preparation/activity")
    ).json();
    assert.deepEqual(asked, ["thread-now"]);
    assert.deepEqual(body.tasks[0].live, live);
  } finally {
    mock.restoreAll();
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});
