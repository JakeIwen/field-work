import test from "node:test";
import assert from "node:assert/strict";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { contextTool } from "../server/context-tools.js";
import { generateAutofill } from "../server/greenhouse-autofill.js";
import {
  publishApplicationAnswers,
  reviewApplicationAnswer,
} from "../server/application-answers.js";

// Woodgrove's "From where do you intend to work?" is an <input type="text">; a
// multi-line answer reached the form with its lines run together.
test("single-line form fields take answers on one line from drafts and reviews", async () => {
  const f = applicationAnswerFixture();
  try {
    f.form.html = f.form.html.replace(
      /<textarea id="question_123" maxlength="500"><\/textarea>/,
      '<input id="question_123" type="text" maxlength="500">',
    );
    const initial = await generateAutofill(f.store, "one", f.read);
    const question = initial.dynamicQuestions![0];
    assert.equal(question.kind, "text");
    const task = f.store.get("task", f.task.id);
    assert.ok(task?.autofillContext);
    f.store.put("task", task.id, {
      ...task,
      autofillContext: { ...task.autofillContext, questions: [question] },
    });
    const draft = {
      ...f.payload.answers[0],
      fieldId: question.id,
      caveats: [],
      manualReviewRequired: false,
      reviewReason: "",
    };
    const rejected = contextTool(
      f.store,
      f.task.threadId,
      "save_application_answers",
      { answers: [{ ...draft, answer: "Portland, Oregon\nAustin, Texas" }] },
    );
    assert.equal(rejected.acceptedCount, 0);
    assert.match(rejected.rejected[0].reason, /single-line/);
    const accepted = contextTool(
      f.store,
      f.task.threadId,
      "save_application_answers",
      { answers: [{ ...draft, answer: "Portland, Oregon or Austin, Texas" }] },
    );
    assert.equal(accepted.acceptedCount, 1);
    const staged = f.store.get("task", f.task.id)!;
    f.store.put("task", staged.id, { ...staged, status: "completed" });
    publishApplicationAnswers(f.store, staged.id, "turn");
    const ready = await generateAutofill(f.store, "one", f.read);
    const current = ready.dynamicQuestions![0];
    assert.throws(
      () =>
        reviewApplicationAnswer(f.store, "one", f.task.id, current.key, {
          answer: "Portland, Oregon\nAustin, Texas",
          answerHash: current.answerHash,
          scriptId: ready.id,
        }),
      /single-line/,
    );
    reviewApplicationAnswer(f.store, "one", f.task.id, current.key, {
      answer: "Portland, Oregon; Austin, Texas",
      answerHash: current.answerHash,
      scriptId: ready.id,
    });
  } finally {
    f.cleanup();
  }
});
