import test from "node:test";
import assert from "node:assert/strict";
import {
  overflowPreparationFixture,
  overflowEventServices,
} from "../fixtures/overflow-preparation.js";
import {
  completePostingDocuments,
  reconcileDocumentPublication,
} from "../../server/task-kinds/task-completion.js";

for (const failureBeforeAck of [false, true]) {
  test(
    `completion/identity publication converges with ${failureBeforeAck ? "failure write before acknowledgement" : "completion immediately followed by acknowledgement"}`,
    { skip: process.platform !== "darwin", timeout: 90000 },
    async (t) => {
      const f = await overflowPreparationFixture(t);
      let completion: ReturnType<typeof completePostingDocuments>;
      try {
        f.manager.start("one", "resume");
        for (let i = 0; i < 10; i++) await f.manager.tick();
        const taskId = f.manager.latest("one")?.documentTaskId;
        assert.ok(taskId);
        await f.workspace.post(`/api/tasks/${taskId}/interrupt`);
        const services = overflowEventServices(f.store);
        t.mock.method(f.workspace.agent, "send", async (threadId: string) => {
          const task = f.store.taskForThread(threadId);
          assert.ok(task);
          completion = completePostingDocuments({
            services,
            task,
            event: {
              method: "turn/completed",
              threadId,
              params: { turn: { id: "completion-race", status: "completed" } },
            },
          });
          if (failureBeforeAck) await completion;
          return { turn: { id: "completion-race" } };
        });
        const response = await f.workspace.post(
          `/api/tasks/${taskId}/message`,
          {
            prompt: "Independent revision",
            clientRequestId: "completion-race-request",
          },
        );
        assert.equal(response.status, 200);
        await Promise.all([
          reconcileDocumentPublication(services, taskId),
          reconcileDocumentPublication(services, taskId),
        ]);
        await completion;
        const result = f.store.get("task", taskId)?.documentResult;
        assert.equal(result?.status, "ready", result?.error);
        assert.equal(result.turnId, "completion-race");
        assert.equal(
          f.store.list("generated_document").length,
          4,
          "exactly one new PDF is published",
        );
      } finally {
        await completion;
        await f.close();
      }
    },
  );
}
