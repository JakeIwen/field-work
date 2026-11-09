import test from "node:test";
import assert from "node:assert/strict";
import type { AutofillAnswerServices } from "../server/task-kinds/autofill-answers.js";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { legacyTask } from "./fixtures/legacy-records.js";
import { autofillReader } from "../server/autofill/fetch.js";
import { generateAutofill } from "../server/greenhouse-autofill.js";
import { startAutofillAnswers } from "../server/task-kinds/autofill-answers.js";
import { validateApplicationAnswers } from "../server/application-answers.js";
import { buildAutofillPlan } from "../server/greenhouse-autofill-plan.js";
import type { TunableSettings } from "../shared/tunables.js";

function overrides(
  f: ReturnType<typeof applicationAnswerFixture>,
  tunables: TunableSettings["tunables"],
) {
  f.store.put("settings", "main", { ...f.store.settings(), tunables });
}

test("autofill fetch attempts and retry waits read settings live", async () => {
  const f = applicationAnswerFixture();
  let calls = 0;
  const waits: number[] = [];
  const read = autofillReader(f.store, "one", {
    read: async () => {
      calls++;
      throw Object.assign(new Error("connection reset"), {
        code: "ECONNRESET",
      });
    },
    wait: async (ms) => {
      waits.push(ms);
    },
  });
  try {
    overrides(f, { "autofill.fetchAttempts": 1 });
    await assert.rejects(
      read("https://job-boards.greenhouse.io/example/jobs/123"),
      /after 1 attempts/,
    );
    assert.equal(calls, 1);
    overrides(f, {
      "autofill.fetchAttempts": 2,
      "autofill.fetchRetryDelayMs": 500,
    });
    await assert.rejects(
      read("https://job-boards.greenhouse.io/example/jobs/123"),
      /after 2 attempts/,
    );
    assert.equal(calls, 3);
    assert.deepEqual(waits, [500]);
  } finally {
    f.cleanup();
  }
});

test("answer task creation applies the live question limit and retains captured questions", async () => {
  const f = applicationAnswerFixture();
  try {
    f.store.remove("task", f.task.id);
    const record = await generateAutofill(f.store, "one", f.read);
    record.dynamicQuestions = [
      f.q,
      { ...f.q, id: "question_124", key: "second-question" },
    ];
    const services: AutofillAnswerServices = {
      store: f.store,
      taskActive: () => true,
      createTask: async (_body, options) =>
        f.store.put(
          "task",
          "captured",
          legacyTask({
            id: "captured",
            status: "running",
            context: _body.context,
            autofillContext: options?.autofillContext,
            manifest: {
              paths: ["source_data/github_evidence_dossier.md"],
              sourceHashes: {},
            },
          }),
        ),
    };
    overrides(f, { "autofill.maxQuestions": 1 });
    await assert.rejects(
      startAutofillAnswers(services, record),
      /more than 1 unresolved/,
    );
    overrides(f, { "autofill.maxQuestions": 2 });
    const task = await startAutofillAnswers(services, record);
    assert.ok(task?.autofillContext);
    assert.equal(task.autofillContext.questions.length, 2);
    overrides(f, { "autofill.maxQuestions": 1 });
    assert.equal((await startAutofillAnswers(services, record))?.id, task.id);
    assert.equal(
      validateApplicationAnswers(task, {
        answers: task.autofillContext.questions.map((q) => ({
          ...f.payload.answers[0],
          fieldId: q.id,
        })),
      }).length,
      2,
    );
  } finally {
    f.cleanup();
  }
});

test("answer length overrides are captured by form planning", () => {
  const f = applicationAnswerFixture();
  try {
    const html = f.form.html.replace('maxlength="500"', 'maxlength="20000"');
    const plan = () =>
      buildAutofillPlan(
        "https://job-boards.greenhouse.io/example/jobs/123",
        html,
        f.api,
        { version: 1, firstName: "Test", email: "test@example.com" },
        { store: f.store, openingId: "one" },
      );
    overrides(f, { "autofill.answerMaxChars": 1500 });
    const captured = plan();
    assert.equal(captured.dynamicQuestions[0].maxLength, 1500);
    overrides(f, { "autofill.answerMaxChars": 20000 });
    assert.equal(plan().dynamicQuestions[0].maxLength, 20000);
    assert.equal(captured.dynamicQuestions[0].maxLength, 1500);
  } finally {
    f.cleanup();
  }
});
