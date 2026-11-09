import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { overflowPreparationFixture } from "../fixtures/overflow-preparation.js";
import { openFixtureWorkspace } from "../fixtures/http-workspace.js";
import { renderApplicationDocuments } from "../../server/application-documents.js";
import {
  handleTaskEvent,
  type TaskEventServices,
} from "../../server/task-kinds/registry.js";

const native = { skip: process.platform !== "darwin", timeout: 60000 };

async function missedStartFixture(t: TestContext) {
  const f = await overflowPreparationFixture(t);
  const run = f.manager.start("one", "resume");
  await f.manager.tick();
  await f.manager.tick();
  const taskId = f.manager.latest("one")?.documentTaskId;
  assert.ok(taskId);
  const task = f.store.get("task", taskId);
  assert.ok(task);
  // Persist the legacy crash window: a repair was requested but no start or
  // acknowledgement associated its turn before the process disappeared.
  f.store.put("task", taskId, {
    ...task,
    status: "disconnected",
    activeTurnId: null,
    overflowRecovery: { preparationId: run.id, failedTurnId: "initial" },
    overflowRecoveryTurns: undefined,
  });
  await f.manager.close();
  await f.workspace.close();
  const reopened = await openFixtureWorkspace(f.store.root, f.store.dataDir);
  t.after(() => reopened.close());
  const status = reopened.agent.status();
  let turnStatus = "inProgress";
  const thread = () => ({
    id: task.threadId,
    turns: [
      { id: "initial", status: "completed", items: [] },
      { id: "missed-repair", status: turnStatus, items: [] },
    ],
  });
  t.mock.method(reopened.agent, "status", () => ({
    ...status,
    available: true,
    connected: true,
  }));
  t.mock.method(reopened.agent, "connect", async () => reopened.agent.status());
  t.mock.method(reopened.agent, "resume", async () => ({ thread: thread() }));
  t.mock.method(reopened.agent, "read", async () => ({ thread: thread() }));
  t.mock.method(reopened.agent, "interrupt", async () => ({
    interrupted: true,
  }));
  t.mock.method(reopened.agent, "send", async () => {
    throw new Error("Injected independent send failure");
  });
  return {
    f,
    reopened,
    taskId,
    threadId: task.threadId,
    completed() {
      turnStatus = "completed";
    },
    async close() {
      try {
        await reopened.close();
      } finally {
        await f.close();
      }
    },
  };
}

async function completeRepair(
  f: Awaited<ReturnType<typeof missedStartFixture>>,
) {
  let finished = () => {};
  const publication = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const services: TaskEventServices = {
    store: f.reopened.store,
    publish(type) {
      if (type === "state") finished();
    },
    launchingTask: () => undefined,
    openingOperation: async (_key, action) => action(),
    generatePreparedAutofill: async () => {
      throw new Error("No autofill expected");
    },
  };
  f.completed();
  handleTaskEvent(services, {
    method: "turn/completed",
    threadId: f.threadId,
    params: { turn: { id: "missed-repair", status: "completed" } },
  });
  await publication;
}

test(
  "cancelled repair stays blocked after missed start, restart, resume, completion and failed user send",
  native,
  async (t) => {
    const f = await missedStartFixture(t);
    try {
      assert.equal(
        (await f.reopened.post(`/api/tasks/${f.taskId}/resume`)).status,
        200,
      );
      const resumed = f.reopened.store.get("task", f.taskId);
      assert.equal(
        resumed?.overflowRecoveryTurns?.["missed-repair"],
        undefined,
        "resume does not invent ownership",
      );
      assert.equal(
        (await f.reopened.post(`/api/tasks/${f.taskId}/interrupt`)).status,
        200,
      );
      await completeRepair(f);
      assert.equal(
        f.reopened.store.get("task", f.taskId)?.documentResult?.turnId,
        "missed-repair",
      );
      assert.equal(f.reopened.store.list("generated_document").length, 2);
      const message = await f.reopened.post(`/api/tasks/${f.taskId}/message`, {
        prompt: "Independent revision",
        clientRequestId: "independent-fails",
      });
      assert.equal(message.status, 500);
      await assert.rejects(
        renderApplicationDocuments(f.reopened.store, f.taskId, "missed-repair"),
        /regenerate/i,
      );
      assert.equal(f.reopened.store.list("generated_document").length, 2);
    } finally {
      await f.close();
    }
  },
);

test(
  "completion alone leaves an uncorrelated repair unknown and unpublished",
  native,
  async (t) => {
    const f = await missedStartFixture(t);
    try {
      await f.reopened.post(`/api/tasks/${f.taskId}/interrupt`);
      await completeRepair(f);
      assert.equal(
        f.reopened.store.get("task", f.taskId)?.documentResult
          ?.ownershipUnknown,
        true,
      );
      await assert.rejects(
        renderApplicationDocuments(f.reopened.store, f.taskId, "missed-repair"),
        /regenerate/i,
      );
    } finally {
      await f.close();
    }
  },
);

for (const matched of [true, false]) {
  test(
    `a started event ${matched ? "resolves its matching" : "cannot resolve an unrelated"} recorded request without an acknowledgement`,
    native,
    async (t) => {
      const f = await overflowPreparationFixture(t);
      try {
        f.manager.start("one", "resume");
        await f.manager.tick();
        await f.manager.tick();
        t.mock.method(f.workspace.agent, "send", async (threadId: string) => {
          const requestId = f.store
            .taskForThread(threadId)
            ?.messages.at(-1)?.clientRequestId;
          handleTaskEvent(
            {
              store: f.store,
              publish() {},
              launchingTask: () => undefined,
              openingOperation: async (_key, action) => action(),
              generatePreparedAutofill: async () => {
                throw new Error("No autofill");
              },
            },
            {
              method: "turn/started",
              threadId,
              params: {
                clientRequestId: matched ? requestId : "unrelated",
                turn: { id: "start-only" },
              },
            },
          );
          throw new Error("Acknowledgement lost");
        });
        await f.manager.tick();
        const taskId = f.manager.latest("one")?.documentTaskId;
        assert.ok(taskId);
        const requests = Object.values(
          f.store.get("task", taskId)?.overflowRequests ?? {},
        );
        assert.equal(requests.length, 1);
        assert.equal(requests[0].turnId, matched ? "start-only" : undefined);
        assert.equal(requests[0].kind, "repair");
      } finally {
        await f.close();
      }
    },
  );
}

test(
  "repair acknowledgement records ownership when turn-start notification is absent",
  native,
  async (t) => {
    const f = await overflowPreparationFixture(t);
    try {
      f.manager.start("one", "resume");
      await f.manager.tick();
      await f.manager.tick();
      t.mock.method(f.workspace.agent, "send", async () => ({
        turn: { id: "ack-only" },
      }));
      await f.manager.tick();
      const taskId = f.manager.latest("one")?.documentTaskId;
      assert.ok(taskId);
      const request = Object.values(
        f.store.get("task", taskId)?.overflowRequests ?? {},
      ).find((entry) => entry.turnId === "ack-only");
      assert.ok(request?.kind === "repair");
      assert.equal(request.preparationId, f.manager.latest("one")?.id);
    } finally {
      await f.close();
    }
  },
);
