import assert from "node:assert/strict";
import { ApplicationPreparationManager } from "../../server/application-preparation.js";
import { generateAutofill } from "../../server/greenhouse-autofill.js";
import {
  publishApplicationAnswers,
  stageApplicationAnswers,
} from "../../server/application-answers.js";
import { startAutofillAnswers } from "../../server/task-kinds/autofill-answers.js";
import { isTaskBusy } from "../../shared/types.js";
import { materialAnswerFixture, saveMaterialPdfs } from "./material-records.js";
import { legacyTask, legacyOpening } from "./legacy-records.js";

type AnswerFixture = ReturnType<typeof materialAnswerFixture>;

async function completeAnswerTurn(f: AnswerFixture, id: string) {
  const task = f.store.get("task", id);
  assert.ok(task?.autofillContext);
  const running = { ...task, status: "running" as const, activeTurnId: "turn" };
  f.store.put("task", id, running);
  stageApplicationAnswers(f.store, running, f.payload);
  const staged = f.store.get("task", id);
  assert.ok(staged);
  f.store.put("task", id, {
    ...staged,
    status: "completed",
    activeTurnId: null,
  });
  publishApplicationAnswers(f.store, id, "turn");
  const completed = f.store.get("task", id);
  assert.ok(completed?.preset === "questions");
  return f.store.put("task", id, {
    ...completed,
    autofillResult: { status: "ready" },
  });
}

async function advancePreparation(
  manager: ApplicationPreparationManager,
  openingId: string,
) {
  const phases: string[] = [];
  for (let i = 0; i < 15; i++) {
    const run = manager.latest(openingId);
    assert.ok(run);
    phases.push(run.phase);
    if (["ready", "failed", "paused"].includes(run.status))
      return { run, phases };
    await manager.tick();
  }
  throw new Error("Preparation did not settle");
}

/** Real form planning, answer publication and PDF reuse; no model or native rendering. */
export function answersPreparationFixture() {
  const f = materialAnswerFixture();
  f.store.remove("task", f.task.id);
  f.store.put(
    "cache_opening",
    "one",
    legacyOpening({
      company_id: "company",
      company: "Example",
      title: "Engineer",
      ...f.store.opening("one"),
    }),
  );
  const answerTurns: string[] = [];
  const documentTasks: string[] = [];
  const manager = new ApplicationPreparationManager(f.store, {
    changed() {},
    generateScript: (openingId, documentIds, preparationId) =>
      generateAutofill(f.store, openingId, f.read, {
        documentIds,
        preparationId,
      }),
    startAnswers: (record) =>
      startAutofillAnswers(
        {
          store: f.store,
          taskActive: (task) => isTaskBusy(task.status),
          createTask: async (body, options) => {
            const id = `answers-${answerTurns.length + 1}`;
            answerTurns.push(id);
            const task = legacyTask({
              ...f.task,
              id,
              preset: "questions",
              status: "handoff",
              threadId: undefined,
              context: body.context,
              autofillContext: options?.autofillContext,
            });
            return f.store.put("task", id, task);
          },
        },
        record,
      ),
    startTask: (id) => completeAnswerTurn(f, id),
    createDocuments: async (run, preset) => {
      assert.equal(preset, "posting-application");
      assert.notEqual(run.scope, "answers");
      const revision = String(documentTasks.length + 1);
      const ids = saveMaterialPdfs(f.store, revision, f.api);
      const document = f.store.document(ids[0]);
      assert.ok(document?.generatedBy);
      documentTasks.push(document.generatedBy);
      const task = f.store.get("task", document.generatedBy);
      assert.ok(task);
      return task;
    },
  });
  return {
    ...f,
    manager,
    advance: (openingId = "one") => advancePreparation(manager, openingId),
    answerTurns,
    documentTasks,
    async close() {
      await manager.close();
      f.cleanup();
    },
  };
}
