import { createWorkspace } from "../../server/server.js";
import { stageApplicationAnswers } from "../../server/application-answers.js";
import { generateAutofill } from "../../server/greenhouse-autofill.js";
import {
  handleTaskEvent,
  type TaskEventServices,
} from "../../server/task-kinds/registry.js";
import type { applicationAnswerFixture } from "./application-answers-fixture.js";
import { legacyTask } from "./legacy-records.js";

type Input = Pick<
  ReturnType<typeof applicationAnswerFixture>,
  "root" | "api" | "form" | "payload"
>;
// Keep the simulated service alive while its form reader is stalled.
setInterval(() => {}, 1000);
process.once("message", async (input: Input) => {
  const workspace = await createWorkspace({
    root: input.root,
    dataDir: `${input.root}/.local/data`,
    port: 0,
    watch: false,
    connectAgent: false,
  });
  const task = workspace.store.get("task", "task");
  if (!task || task.preset !== "questions")
    throw new Error("Missing fixture task");
  const running = legacyTask({
    ...task,
    preset: "questions",
    status: "running",
  });
  workspace.store.put("task", running.id, running);
  stageApplicationAnswers(workspace.store, running, input.payload);
  let notified = false;
  const services: TaskEventServices = {
    store: workspace.store,
    publish() {},
    launchingTask: () => undefined,
    openingOperation: async (_key, action) => action(),
    generatePreparedAutofill: (id) =>
      generateAutofill(workspace.store, id, async () => {
        if (!notified) {
          notified = true;
          process.send?.("saving");
        }
        // A process crash, unlike graceful close, never settles this form read.
        return new Promise(() => {});
      }),
  };
  handleTaskEvent(services, {
    method: "turn/completed",
    threadId: "thread",
    params: { turn: { id: "turn", status: "completed" } },
  });
});
