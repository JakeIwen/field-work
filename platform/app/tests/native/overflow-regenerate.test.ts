import { hasUnresolvedOverflowTurn } from "../../server/overflow-recovery-ownership.js";
import { legacyTask } from "../fixtures/legacy-records.js";
import test from "node:test";
import assert from "node:assert/strict";
import { fixture as codexFixture } from "../fixtures/codex-fixture.js";
import {
  overflowPreparationFixture,
  overflowEventServices,
} from "../fixtures/overflow-preparation.js";
import { handleTaskEvent } from "../../server/task-kinds/registry.js";

test("a prior resolved request cannot hide the latest unknown failure", () => {
  const task = legacyTask({
    id: "task",
    preset: "posting-resume",
    status: "disconnected",
    messages: [
      { role: "user", text: "Earlier request", clientRequestId: "earlier" },
    ],
    overflowRequests: { earlier: { kind: "independent", turnId: "known" } },
    documentResult: {
      status: "failed",
      turnId: "unknown",
      ownershipUnknown: true,
    },
  });
  assert.equal(hasUnresolvedOverflowTurn(task), true);
  assert.equal(
    hasUnresolvedOverflowTurn({ ...task, activeTurnId: "known" }),
    false,
  );
});

for (const completedBeforeFailure of [false, true]) {
  test(
    `regenerate starts a new document task after real adapter uncertainty${completedBeforeFailure ? " following unknown completion" : " without completion"}`,
    { skip: process.platform !== "darwin", timeout: 60000 },
    async (t) => {
      const f = await overflowPreparationFixture(t, 99);
      let publication = () => {};
      const services = overflowEventServices(f.store, (type) => {
        if (type === "state") publication();
      });
      const options: Parameters<typeof codexFixture>[0] = {
        onEvent: (event) => handleTaskEvent(services, event),
      };
      const protocol = codexFixture(options);
      try {
        const thread = await protocol.adapter.start({
          cwd: protocol.draft,
          prompt: "Synthetic initial turn",
        });
        await protocol.adapter.interrupt(thread.threadId);
        f.manager.start("one", "resume");
        await f.manager.tick();
        await f.manager.tick();
        const priorId = f.manager.latest("one")?.documentTaskId;
        assert.ok(priorId);
        const prior = f.store.get("task", priorId);
        assert.ok(prior);
        f.store.put("task", priorId, { ...prior, threadId: thread.threadId });
        options.turnStartError = "Synthetic turn acknowledgement failure";
        t.mock.method(
          f.workspace.agent,
          "send",
          async (threadId: string, prompt: string) => {
            if (completedBeforeFailure) {
              const finished = new Promise<void>((resolve) => {
                publication = resolve;
              });
              protocol.notify("turn/completed", {
                threadId,
                turn: { id: "unidentified", status: "completed" },
              });
              await finished;
            }
            return protocol.adapter.send(threadId, prompt);
          },
        );
        await f.manager.tick();
        assert.ok(
          protocol.events.some(
            (event) => event.method === "adapter/turnUncertain",
          ),
        );
        assert.equal(f.store.get("task", priorId)?.status, "disconnected");
        if (completedBeforeFailure)
          assert.equal(
            f.store.get("task", priorId)?.documentResult?.ownershipUnknown,
            true,
          );
        const unresolved = f.store.get("task", priorId)?.overflowRequests;
        const count = f.store.list("task").length;
        f.manager.start("one", "resume");
        await f.manager.tick();
        await f.manager.tick();
        assert.notEqual(
          f.manager.latest("one")?.documentTaskId,
          priorId,
          "regenerate must not re-adopt the uncertain task",
        );
        assert.equal(f.store.list("task").length, count + 1);
        assert.deepEqual(
          f.store.get("task", priorId)?.overflowRequests,
          unresolved,
        );
        assert.equal(f.manager.latest("one")?.status, "running");
      } finally {
        options.onEvent = undefined;
        protocol.cleanup();
        await f.close();
      }
    },
  );
}
