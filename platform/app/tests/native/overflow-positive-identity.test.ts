import { Store } from "../../server/storage.js";
import test from "node:test";
import assert from "node:assert/strict";
import { overflowPreparationFixture } from "../fixtures/overflow-preparation.js";
import {
  handleTaskEvent,
  type TaskEventServices,
} from "../../server/task-kinds/registry.js";

const native = { skip: process.platform !== "darwin", timeout: 90000 };

async function completeWithoutStart(
  f: Awaited<ReturnType<typeof overflowPreparationFixture>>,
  threadId: string,
  turnId: string,
) {
  let finish = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const services: TaskEventServices = {
    store: f.store,
    publish(type) {
      if (type === "state") finish();
    },
    launchingTask: () => undefined,
    openingOperation: async (_key, action) => action(),
    generatePreparedAutofill: async () => {
      throw new Error("No autofill expected");
    },
  };
  handleTaskEvent(services, {
    method: "turn/completed",
    threadId,
    params: { turn: { id: turnId, status: "completed" } },
  });
  await finished;
}

test(
  "a new preparation can repair an adopted positively independent revision despite old cancellation",
  native,
  async (t) => {
    const f = await overflowPreparationFixture(t, 99);
    let release = () => {};
    let userSend: ReturnType<typeof f.workspace.post> | undefined;
    try {
      f.manager.start("one", "resume");
      for (let i = 0; i < 8; i++) await f.manager.tick();
      const taskId = f.manager.latest("one")?.documentTaskId;
      assert.ok(taskId);
      await f.workspace.post(`/api/tasks/${taskId}/interrupt`);
      let started = () => {};
      const waiting = new Promise<void>((resolve) => {
        started = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.beforeFollowup(async () => {
        started();
        await gate;
      });
      userSend = f.workspace.post(`/api/tasks/${taskId}/message`, {
        prompt: "Independent revision",
        clientRequestId: "adopted-user",
      });
      await waiting;
      const next = f.manager.start("one", "resume");
      await f.manager.tick();
      await f.manager.tick();
      assert.equal(f.manager.latest("one")?.documentTaskId, taskId);
      release();
      assert.equal((await userSend).status, 200);
      f.beforeFollowup(async () => {});
      const before = f.followups.length;
      await f.manager.tick();
      assert.equal(
        f.followups.length,
        before + 1,
        f.manager.latest("one")?.error,
      );
      assert.equal(
        f.store.get("application_preparation", next.id)?.overflowAttempts
          ?.resume,
        1,
      );
    } finally {
      release();
      await userSend;
      await f.close();
    }
  },
);

for (const acknowledged of [true, false]) {
  test(
    `independent completion without start ${acknowledged ? "publishes after acknowledgement" : "retains unresolved provenance after lost acknowledgement"}`,
    native,
    async (t) => {
      const f = await overflowPreparationFixture(t);
      try {
        f.manager.start("one", "resume");
        for (let i = 0; i < 10; i++) await f.manager.tick();
        const taskId = f.manager.latest("one")?.documentTaskId;
        assert.ok(taskId);
        await f.workspace.post(`/api/tasks/${taskId}/interrupt`);
        t.mock.method(f.workspace.agent, "send", async (threadId: string) => {
          await completeWithoutStart(f, threadId, "user-without-start");
          if (!acknowledged) throw new Error("Lost acknowledgement");
          return { turn: { id: "user-without-start" } };
        });
        const response = await f.workspace.post(
          `/api/tasks/${taskId}/message`,
          {
            prompt: "Independent revision",
            clientRequestId: "user-missed-start",
          },
        );
        assert.equal(response.status, acknowledged ? 200 : 500);
        const task = f.store.get("task", taskId);
        if (acknowledged) {
          assert.equal(
            task?.documentResult?.status,
            "ready",
            task?.documentResult?.error,
          );
          assert.equal(f.store.list("generated_document").length, 4);
          assert.equal(
            (
              await f.workspace.post(`/api/tasks/${taskId}/message`, {
                prompt: "Independent revision",
                clientRequestId: "user-missed-start",
              })
            ).status,
            200,
          );
          assert.equal(
            f.store.list("generated_document").length,
            4,
            "duplicate acknowledgement must not publish twice",
          );
        } else {
          assert.equal(
            task?.overflowRequests?.["user-missed-start"]?.kind,
            "independent",
          );
          assert.equal(
            task?.overflowRequests?.["user-missed-start"]?.turnId,
            undefined,
          );
          assert.equal(task?.documentResult?.status, "failed");
          assert.match(task?.documentResult?.error ?? "", /regenerate/i);
          assert.equal(f.store.list("generated_document").length, 3);
          await f.manager.close();
          await f.workspace.close();
          const reopened = new Store(f.store.root, f.store.dataDir, {
            readOnly: true,
          });
          try {
            assert.deepEqual(
              reopened.get("task", taskId)?.overflowRequests?.[
                "user-missed-start"
              ],
              { kind: "independent" },
            );
          } finally {
            reopened.close();
          }
        }
      } finally {
        await f.close();
      }
    },
  );
}
