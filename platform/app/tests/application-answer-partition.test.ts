import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  applicationAnswerFixture,
  source,
} from "./fixtures/application-answers-fixture.js";
import { contextTool } from "../server/context-tools.js";
import { atomicWrite } from "../server/storage.js";
import {
  generateAutofill,
  savedAutofillScript,
} from "../server/greenhouse-autofill.js";
import {
  stageApplicationAnswers,
  publishApplicationAnswers,
} from "../server/application-answers.js";
import type { AutofillQuestion } from "../shared/greenhouse-autofill.js";

async function twoQuestions() {
  const f = applicationAnswerFixture();
  const label = "What makes this role a good fit for you?";
  f.api.questions.push({
    label,
    required: true,
    fields: [{ name: "question_456", type: "textarea" }],
  });
  f.form.html = f.form.html.replace(
    "</form>",
    `<label for="question_456">${label}</label><textarea id="question_456" maxlength="30"></textarea></form>`,
  );
  const script = await generateAutofill(f.store, "one", f.read);
  const task = f.store.get("task", f.task.id);
  assert.ok(task?.autofillContext);
  const questions = script.dynamicQuestions ?? [];
  assert.equal(questions.length, 2);
  const scoped = {
    ...task,
    autofillContext: { ...task.autofillContext, questions },
  };
  f.store.put("task", task.id, scoped);
  const good = {
    ...f.payload.answers[0],
    answer: "Supported engineering work.",
    caveats: [],
    manualReviewRequired: false,
    reviewReason: "",
  };
  const bad = {
    ...good,
    fieldId: "question_456",
    answer: "Rejected answer that is much longer than thirty characters.",
  };
  return { ...f, scoped, good, bad };
}

test("a rejected sibling does not prevent valid answers from reaching the autofill script", async () => {
  const f = await twoQuestions();
  try {
    const result = contextTool(
      f.store,
      f.task.threadId,
      "save_application_answers",
      { answers: [f.good, f.bad] },
    );
    assert.equal(result.saved, true);
    assert.equal(result.acceptedCount, 1);
    assert.equal(result.manualReviewCount, 1);
    assert.equal(result.rejected[0].fieldId, "question_456");
    assert.match(result.rejected[0].reason, /validation failed.*length/i);
    assert.equal(
      f.store.list("application_answer_set").length,
      0,
      "publication waits for completion",
    );
    const staged = f.store.get("task", f.task.id);
    assert.ok(staged?.autofillDraft);
    assert.equal(staged.autofillDraft.answers[0].answer, f.good.answer);
    assert.equal(staged.autofillDraft.answers[1].answer, "");
    assert.equal(staged.autofillDraft.answers[1].needsInput, true);
    f.store.put("task", staged.id, { ...staged, status: "completed" });
    publishApplicationAnswers(f.store, staged.id, "turn");
    const script = await generateAutofill(f.store, "one", f.read);
    assert.ok(script.answers.some((answer) => answer.value === f.good.answer));
    assert.ok(!script.answers.some((answer) => answer.value === f.bad.answer));
    const review = script.dynamicQuestions?.find(
      (q) => q.id === "question_456",
    );
    assert.equal(review?.needsInput, true);
    assert.equal(review?.manualReviewRequired, true);
    assert.match(review?.reviewReason ?? "", /validation failed/i);
    assert.ok(script.review.some((item) => item.label === review?.label));
    assert.ok(
      !savedAutofillScript(f.store, "one", script.id).script.includes(
        f.bad.answer,
      ),
    );
  } finally {
    f.cleanup();
  }
});

test("a later corrected save clears the validation flag while retaining the valid sibling", async () => {
  const f = await twoQuestions();
  try {
    stageApplicationAnswers(f.store, f.scoped, { answers: [f.good, f.bad] });
    const staged = f.store.get("task", f.task.id);
    const result = stageApplicationAnswers(f.store, staged, {
      answers: [f.good, { ...f.bad, answer: "Supported relevant experience." }],
    });
    assert.equal(result.acceptedCount, 2);
    assert.equal(result.manualReviewCount, 0);
    assert.deepEqual(result.rejected, []);
    assert.equal(
      f.store.get("task", f.task.id)?.autofillDraft?.answers[0].answer,
      f.good.answer,
    );
    assert.equal(
      f.store.get("task", f.task.id)?.autofillDraft?.answers[1]
        .manualReviewRequired,
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("an ungrounded declaration stays blank without discarding an unrelated supported answer", async () => {
  const f = await twoQuestions();
  try {
    const visa: AutofillQuestion = {
      id: "visa",
      key: "visa",
      label: "Will you require sponsorship to work in Canada?",
      kind: "select",
      required: true,
      maxLength: 100,
      options: ["Yes", "No"],
      mode: "unmatched",
      profileOnly: true,
    };
    const task = {
      ...f.scoped,
      manifest: {
        ...f.scoped.manifest,
        paths: [source, "confirmed-profile.json"],
      },
      autofillContext: {
        ...f.scoped.autofillContext,
        questions: [f.q, visa],
        postingCountry: "CA",
        profileSnapshot: {
          requiresSponsorshipNowOrFuture: false,
          applicationLocation: { country: "US" },
        },
      },
    };
    const answer = {
      ...f.good,
      fieldId: visa.id,
      answer: "No",
      sourcePaths: ["confirmed-profile.json"],
      profileKeys: ["applicationLocation.country"],
    };
    const result = stageApplicationAnswers(f.store, task, {
      answers: [f.good, answer],
    });
    assert.equal(result.acceptedCount, 1);
    assert.match(result.rejected[0].reason, /its own confirmed profile fact/);
    const saved = f.store.get("task", f.task.id)?.autofillDraft?.answers;
    assert.equal(saved?.[0].answer, f.good.answer);
    assert.equal(saved?.[1].answer, "");
    assert.deepEqual(saved?.[1].sourcePaths, []);
    assert.deepEqual(saved?.[1].profileKeys, []);
  } finally {
    f.cleanup();
  }
});

test("malformed question identities never replace the previously staged set", async () => {
  const f = await twoQuestions();
  try {
    stageApplicationAnswers(f.store, f.scoped, { answers: [f.good, f.bad] });
    const before = f.store.get("task", f.task.id)?.autofillDraft;
    for (const answers of [
      [],
      [f.good],
      [f.good, f.good],
      [f.good, { ...f.bad, fieldId: "other-form" }],
      [f.good, null],
    ]) {
      assert.throws(
        () => stageApplicationAnswers(f.store, f.scoped, { answers }),
        /every captured|Unknown or duplicate/,
      );
      assert.deepEqual(f.store.get("task", f.task.id)?.autofillDraft, before);
    }
  } finally {
    f.cleanup();
  }
});

test("partial acceptance does not bypass source or successful-turn publication checks", async () => {
  const f = await twoQuestions();
  try {
    stageApplicationAnswers(f.store, f.scoped, { answers: [f.good, f.bad] });
    assert.throws(
      () => publishApplicationAnswers(f.store, f.task.id, "turn"),
      /completed turn/,
    );
    const staged = f.store.get("task", f.task.id);
    assert.ok(staged);
    f.store.put("task", staged.id, { ...staged, status: "completed" });
    atomicWrite(path.join(f.root, source), "Updated evidence");
    assert.throws(
      () => publishApplicationAnswers(f.store, staged.id, "turn"),
      /evidence changed/,
    );
    assert.equal(f.store.list("application_answer_set").length, 0);
  } finally {
    f.cleanup();
  }
});
