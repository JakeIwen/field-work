import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import {
  handleTaskEvent,
  type TaskEventServices,
} from "../server/task-kinds/registry.js";
import { stageApplicationAnswers } from "../server/application-answers.js";
import {
  generateAutofill,
  savedAutofillScript,
} from "../server/greenhouse-autofill.js";
import {
  materialAnswerFixture,
  saveMaterialPdfs,
} from "./fixtures/material-records.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

function completionServices(
  workspace: Awaited<ReturnType<typeof openFixtureWorkspace>>,
  read: ReturnType<typeof materialAnswerFixture>["read"],
  formGate: Promise<void>,
  onStart: () => void,
  onFinish: () => void,
): TaskEventServices {
  return {
    store: workspace.store,
    publish() {
      if (
        ["ready", "failed"].includes(
          workspace.store.get("task", "task")?.autofillResult?.status ?? "",
        )
      )
        onFinish();
    },
    launchingTask: () => undefined,
    openingOperation: async (_key, action) => action(),
    generatePreparedAutofill: (id) => {
      onStart();
      return generateAutofill(workspace.store, id, async (url) => {
        await formGate;
        return read(url);
      });
    },
  };
}

for (const beforeCompletion of [true, false]) {
  test(
    `characterization: Interrupt does not veto script publication ${beforeCompletion ? "from a later successful completion" : "already saving after turn completion"}`,
    { timeout: 10000 },
    async (t) => {
      const f = materialAnswerFixture();
      saveMaterialPdfs(f.store, "original", f.api);
      f.store.close();
      const workspace = await openFixtureWorkspace(f.root);
      let release: () => void = () => {};
      const formGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let finish: () => void = () => {};
      const publication = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let publicationStarted = false;
      try {
        const task = workspace.store.get("task", "task");
        assert.ok(task?.preset === "questions");
        const running = {
          ...task,
          status: "running" as const,
          activeTurnId: "turn",
        };
        workspace.store.put("task", task.id, running);
        stageApplicationAnswers(workspace.store, running, f.payload);
        const services = completionServices(
          workspace,
          f.read,
          formGate,
          () => {
            publicationStarted = true;
          },
          finish,
        );
        t.mock.method(
          workspace.agent,
          "interrupt",
          async (threadId: string) => {
            assert.equal(threadId, "thread");
            return beforeCompletion
              ? { interrupted: true, turnId: "turn" }
              : { interrupted: false, reason: "No active turn." };
          },
        );
        const completed = () =>
          handleTaskEvent(services, {
            method: "turn/completed",
            threadId: "thread",
            params: { turn: { id: "turn", status: "completed" } },
          });
        if (!beforeCompletion) completed();
        const interrupt = await workspace.post(
          `/api/tasks/${task.id}/interrupt`,
        );
        assert.equal(interrupt.status, 200);
        assert.equal((await interrupt.json()).interrupted, beforeCompletion);
        if (beforeCompletion) completed();
        assert.equal(
          workspace.store.get("task", task.id)?.autofillResult?.status,
          "saving",
        );
        release();
        await publication;
        // Characterization, not the desired cancellation contract: the route asks
        // Codex to interrupt but sets no per-task publication cancellation guard.
        const result = workspace.store.get("task", task.id)?.autofillResult;
        assert.equal(result?.status, "ready", result?.error);
        assert.ok(result?.scriptId);
        assert.ok(
          savedAutofillScript(workspace.store, "one", result.scriptId).script,
        );
        assert.equal(workspace.store.list("application_answer_set").length, 1);
      } finally {
        release();
        if (publicationStarted) await publication;
        await workspace.close();
        rmSync(f.root, { recursive: true, force: true });
      }
    },
  );
}
