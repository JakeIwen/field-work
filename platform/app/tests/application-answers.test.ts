import {
  applicationAnswerFixture as fixture,
  url,
  label,
  source,
} from "./fixtures/application-answers-fixture.js";
import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { atomicWrite } from "../server/storage.js";
import {
  generateAutofill,
  savedAutofillScript,
  savedAutofills,
} from "../server/greenhouse-autofill.js";
import {
  narrativeQuestion,
  validateApplicationAnswers,
  stageApplicationAnswers,
  publishApplicationAnswers,
  reviewApplicationAnswer,
} from "../server/application-answers.js";
import { contextTool } from "../server/context-tools.js";

test("only narrative questions qualify; source limits and identity are bound into their keys", () => {
  const field = {
    id: "question_123",
    label,
    kind: "textarea",
    required: true,
    maxLength: 1000,
  };
  assert.ok(narrativeQuestion(field, url));
  for (const sensitive of [
    "What is your salary expectation?",
    "Describe your disability accommodations",
    "What is your citizenship?",
    "Describe your racial background",
    "What visa sponsorship do you need?",
  ])
    assert.equal(narrativeQuestion({ ...field, label: sensitive }, url), null);
  assert.equal(narrativeQuestion({ ...field, kind: "select" }, url), null);
  assert.equal(
    narrativeQuestion({ ...field, id: "cover_letter_text" }, url),
    null,
  );
  assert.notEqual(
    narrativeQuestion(field, url)?.key,
    narrativeQuestion({ ...field, maxLength: 200 }, url)?.key,
  );
});
test("structured tool refuses missing, duplicate, overlong and ungrounded answers", () => {
  const f = fixture();
  try {
    assert.equal(validateApplicationAnswers(f.task, f.payload).length, 1);
    const base = f.payload.answers[0];
    for (const patch of [
      { fieldId: "other" },
      { answer: "x".repeat(501) },
      { sourcePaths: [] },
      { sourcePaths: ["outside.txt"] },
      { manualReviewRequired: true, reviewReason: "" },
      { needsInput: true, answer: "" },
    ]) {
      const invalid = { ...base, ...patch };
      if (patch.needsInput) invalid.manualReviewRequired = false;
      assert.throws(() =>
        validateApplicationAnswers(f.task, { answers: [invalid] }),
      );
    }
    assert.throws(() =>
      validateApplicationAnswers(f.task, { answers: [base, base] }),
    );
    f.store.put(
      "task",
      "plain" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        id: "plain",
        preset: "questions",
        threadId: "plain",
        status: "running",
      } as Records["task"],
    );
    assert.throws(() =>
      contextTool(f.store, "plain", "save_application_answers", f.payload),
    );
    assert.equal(
      contextTool(f.store, "thread", "save_application_answers", f.payload)
        .saved,
      true,
    );
  } finally {
    f.cleanup();
  }
});
test("only completed matching turns publish; manual-review drafts stay out of code until reviewed", async () => {
  const f = fixture();
  try {
    stageApplicationAnswers(f.store, f.task, f.payload);
    assert.throws(
      () => publishApplicationAnswers(f.store, "task", "turn"),
      /completed turn/,
    );
    f.store.put(
      "task",
      "task" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...f.store.get("task", "task"),
        status: "completed",
        activeTurnId: null,
      } as Records["task"],
    );
    assert.throws(
      () => publishApplicationAnswers(f.store, "task", "other-turn"),
      /completed turn/,
    );
    publishApplicationAnswers(f.store, "task", "turn");
    const held = await generateAutofill(f.store, "one", f.read);
    const question = held.dynamicQuestions![0];
    assert.equal(question.manualReviewRequired, true);
    assert.ok(
      held.review.some((r) => r.reason.startsWith("Manual review required:")),
    );
    assert.ok(
      !savedAutofillScript(f.store, "one", held.id).script.includes(
        f.payload.answers[0].answer,
      ),
    );
    const reviewed = 'User reviewed this answer.\nQuotes: "exact".';
    reviewApplicationAnswer(f.store, "one", "task", f.q.key, {
      answer: reviewed,
      answerHash: question.answerHash,
    });
    assert.equal(
      savedAutofills(f.store, "one")[0].stale,
      true,
      "reviewing an answer invalidates the prior script",
    );
    assert.throws(
      () =>
        reviewApplicationAnswer(f.store, "one", "task", f.q.key, {
          answer: "Stale edit",
          answerHash: question.answerHash,
        }),
      /changed/,
    );
    const ready = await generateAutofill(f.store, "one", f.read);
    assert.equal(ready.dynamicQuestions![0].manualReviewRequired, false);
    assert.ok(ready.answers.some((a) => a.value === reviewed));
    assert.ok(
      savedAutofillScript(f.store, "one", ready.id).script.includes(
        JSON.stringify(reviewed),
      ),
    );
    assert.equal(
      f.store.personalExport().records.application_answer_set.length,
      1,
    );
    assert.equal(
      f.store.personalExport().records.application_answer_review.length,
      1,
    );
    assert.equal(f.store.list("application").length, 0);
    atomicWrite(path.join(f.root, source), "Changed evidence.");
    assert.equal(savedAutofills(f.store, "one")[0].stale, true);
    const changed = await generateAutofill(f.store, "one", f.read);
    assert.equal(changed.dynamicQuestions![0].answer, reviewed);
    assert.throws(
      () => publishApplicationAnswers(f.store, "task", "turn"),
      /evidence changed/,
    );
  } finally {
    f.cleanup();
  }
});
test("clear grounded drafts are included automatically without an unnecessary manual gate", async () => {
  const f = fixture();
  try {
    f.payload.answers[0].manualReviewRequired = false;
    f.payload.answers[0].reviewReason = "";
    stageApplicationAnswers(f.store, f.task, f.payload);
    f.store.put(
      "task",
      "task" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...f.store.get("task", "task"),
        status: "completed",
      } as Records["task"],
    );
    publishApplicationAnswers(f.store, "task", "turn");
    const result = await generateAutofill(f.store, "one", f.read);
    assert.ok(
      result.answers.some(
        (a) => a.source === "codex" && a.value === f.payload.answers[0].answer,
      ),
    );
    assert.ok(!result.review.some((r) => r.label === label));
  } finally {
    f.cleanup();
  }
});

test("completion preserves a same-turn save rejection instead of claiming no save was attempted", () => {
  const f = fixture();
  try {
    const task = f.store.get("task", f.task.id);
    assert.ok(task);
    const legacy = {
      ...task,
      status: "completed" as const,
      events: [
        {
          method: "adapter/contextTool",
          turnId: "turn",
          params: {
            tool: "save_application_answers",
            success: false,
            error:
              "US work-permission facts cannot answer a question about an unverified job country.",
          },
        },
      ],
    };
    f.store.put("task", task.id, legacy);
    assert.throws(
      () => publishApplicationAnswers(f.store, task.id, "turn"),
      /Saving application answers was rejected: US work-permission/,
    );
    assert.throws(
      () => publishApplicationAnswers(f.store, task.id, "different-turn"),
      /did not save/,
    );
  } finally {
    f.cleanup();
  }
});
