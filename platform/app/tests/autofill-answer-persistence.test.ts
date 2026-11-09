import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Store, atomicWrite, sha256 } from "../server/storage.js";
import {
  generateAutofill,
  savedAutofills,
  savedAutofillScript,
  buildAutofillPlan,
} from "../server/greenhouse-autofill.js";
import {
  publishApplicationAnswers,
  reviewApplicationAnswer,
  stageApplicationAnswers,
} from "../server/application-answers.js";
import { startAutofillAnswers } from "../server/task-kinds/autofill-answers.js";
import {
  applicationAnswerFixture,
  label,
  source,
  url,
} from "./fixtures/application-answers-fixture.js";

async function reviewedFixture() {
  const f = applicationAnswerFixture();
  stageApplicationAnswers(f.store, f.task, f.payload);
  const task = f.store.get("task", "task");
  assert.ok(task);
  f.store.put("task", task.id, {
    ...task,
    status: "completed",
    activeTurnId: null,
  });
  publishApplicationAnswers(f.store, task.id, "turn");
  const initial = await generateAutofill(f.store, "one", f.read);
  const q = initial.dynamicQuestions![0];
  const answer = 'My own answer.\nKeep "this wording" exactly.';
  reviewApplicationAnswer(f.store, "one", task.id, q.key, {
    answer,
    answerHash: q.answerHash,
    scriptId: initial.id,
  });
  return { ...f, initial, answer };
}

test("a reviewed answer saves from a script made stale by evidence, profile and Opening changes", async () => {
  const f = applicationAnswerFixture();
  try {
    stageApplicationAnswers(f.store, f.task, f.payload);
    const task = f.store.get("task", "task")!;
    f.store.put("task", task.id, {
      ...task,
      status: "completed",
      activeTurnId: null,
    });
    publishApplicationAnswers(f.store, task.id, "turn");
    const held = await generateAutofill(f.store, "one", f.read);
    const q = held.dynamicQuestions![0];
    assert.equal(q.manualReviewRequired, true);
    atomicWrite(path.join(f.root, source), "Changed source evidence.");
    atomicWrite(
      path.join(f.root, ".local/greenhouse/profile.json"),
      JSON.stringify({ version: 1, firstName: "Changed", email: "t@x.test" }),
    );
    const opening = f.store.get("cache_opening", "one")!;
    f.store.put("cache_opening", "one", { ...opening, hash: "changed" });
    assert.deepEqual(savedAutofills(f.store, "one")[0].staleReasons, [
      "Saved profile answers changed.",
      "Opening details changed.",
      "Evidence used for written answers changed.",
    ]);
    reviewApplicationAnswer(f.store, "one", task.id, q.key, {
      answer: "Yes, my reviewed answer.",
      answerHash: q.answerHash,
      scriptId: held.id,
    });
    const next = await generateAutofill(f.store, "one", f.read);
    assert.equal(next.dynamicQuestions![0].answer, "Yes, my reviewed answer.");
    assert.ok(next.dynamicQuestions![0].reviewedAt);
    assert.throws(
      () =>
        reviewApplicationAnswer(f.store, "one", task.id, q.key, {
          answer: "An edit from the outdated view",
          answerHash: q.answerHash,
          scriptId: held.id,
        }),
      /changed/,
      "a later answer to the same question outdates the old script's view",
    );
  } finally {
    f.cleanup();
  }
});

test("saved edits survive newer AI drafts, source changes, script regeneration and database reopening", async () => {
  const f = await reviewedFixture();
  try {
    const firstScript = savedAutofillScript(
      f.store,
      "one",
      f.initial.id,
    ).script;
    const oldSet = f.store.get("application_answer_set", "task");
    assert.ok(oldSet);
    f.store.put("application_answer_set", "new-task", {
      ...oldSet,
      id: "new-task",
      taskId: "new-task",
      createdAt: "2099-01-01T00:00:00.000Z",
      answers: oldSet.answers.map((a) => ({
        ...a,
        answer: "New AI wording",
        manualReviewRequired: false,
      })),
    });
    atomicWrite(path.join(f.root, source), "New source evidence.");
    const next = await generateAutofill(f.store, "one", f.read);
    assert.equal(next.dynamicQuestions![0].answer, f.answer);
    assert.ok(next.dynamicQuestions![0].reviewedAt);
    assert.equal(next.answers.find((a) => a.label === label)?.source, "user");
    assert.ok(
      savedAutofillScript(f.store, "one", next.id).script.includes(
        JSON.stringify(f.answer),
      ),
    );
    assert.equal(
      savedAutofillScript(f.store, "one", f.initial.id).script,
      firstScript,
    );
    const q = next.dynamicQuestions![0];
    reviewApplicationAnswer(f.store, "one", q.taskId!, q.key, {
      answer: "My revised answer",
      answerHash: q.answerHash,
      scriptId: next.id,
    });
    assert.throws(
      () =>
        reviewApplicationAnswer(f.store, "one", q.taskId!, q.key, {
          answer: "Stale edit",
          answerHash: q.answerHash,
          scriptId: next.id,
        }),
      /changed/,
    );
    const newer = await generateAutofill(f.store, "one", f.read);
    assert.equal(newer.dynamicQuestions![0].answer, "My revised answer");
    const exported = f.store.personalExport().records.application_answer_review;
    assert.equal(exported[0].question?.label, label);
    assert.equal(exported[0].url, url);
    const reopened = new Store(f.root, f.store.dataDir);
    try {
      const restored = await generateAutofill(reopened, "one", f.read);
      assert.equal(restored.dynamicQuestions![0].answer, "My revised answer");
    } finally {
      reopened.close();
    }
    assert.equal(f.store.list("application").length, 0);
  } finally {
    f.cleanup();
  }
});

test("legacy reviews are recovered from their captured questions without a migration", async () => {
  const f = await reviewedFixture();
  try {
    const reviewId = sha256(`one:task:${f.q.key}`);
    const review = f.store.get("application_answer_review", reviewId);
    assert.ok(review);
    const { question: _question, url: _url, ...legacy } = review;
    f.store.put("application_answer_review", reviewId, legacy);
    atomicWrite(path.join(f.root, source), "New source evidence.");
    const next = await generateAutofill(f.store, "one", f.read);
    assert.equal(next.dynamicQuestions![0].answer, f.answer);
  } finally {
    f.cleanup();
  }
});

test("saved edits are excluded from automatic and explicitly requested Codex redrafting", async () => {
  const f = await reviewedFixture();
  try {
    let calls = 0;
    const services = {
      store: f.store,
      taskActive: () => false,
      createTask: async () => {
        calls++;
        return undefined;
      },
    };
    // Even a script saved before the edit must consult the durable review before scheduling work.
    assert.equal(await startAutofillAnswers(services, f.initial, true), null);
    const next = await generateAutofill(f.store, "one", f.read);
    assert.equal(await startAutofillAnswers(services, next), null);
    assert.equal(calls, 0);
  } finally {
    f.cleanup();
  }
});

test("saved edits stay within the same opening, posting and exact question constraints", async () => {
  const f = await reviewedFixture();
  try {
    const opening = f.store.opening("one");
    assert.ok(opening);
    f.store.put("custom_opening", "two", { ...opening, id: "two" });
    assert.equal(
      (await generateAutofill(f.store, "two", f.read)).dynamicQuestions![0]
        .answer,
      undefined,
    );
    const profile = JSON.parse(
      readFileSync(path.join(f.root, ".local/greenhouse/profile.json"), "utf8"),
    );
    const variants = [
      {
        html: f.form.html.replace('maxlength="500"', 'maxlength="20"'),
        api: f.api,
      },
      {
        html: f.form.html.replace(label, "Describe a different project"),
        api: {
          ...f.api,
          questions: f.api.questions.map((q) =>
            q.label === label
              ? { ...q, label: "Describe a different project" }
              : q,
          ),
        },
      },
      {
        html: f.form.html,
        api: {
          ...f.api,
          questions: f.api.questions.map((q) =>
            q.label === label
              ? { ...q, description: "Use only paid employment" }
              : q,
          ),
        },
      },
    ];
    for (const variant of variants) {
      const plan = buildAutofillPlan(url, variant.html, variant.api, profile, {
        store: f.store,
        openingId: "one",
      });
      assert.equal(
        plan.fields.some((field) => field.value === f.answer),
        false,
      );
    }
    f.store.put("custom_opening", "one", {
      ...opening,
      url: url.replace("123", "456"),
    });
    const next = await generateAutofill(f.store, "one", async (u) => ({
      ...(await f.read(u)),
      text: u.includes("boards-api")
        ? JSON.stringify({ ...f.api, id: 456 })
        : f.form.html,
    }));
    assert.equal(
      next.answers.some((a) => a.value === f.answer),
      false,
    );
  } finally {
    f.cleanup();
  }
});

test("a user-supplied choice survives profile/posting hashes and remains editable after regeneration", async () => {
  const f = applicationAnswerFixture();
  try {
    const options = ["They/Them", "He/Him"];
    const api = {
      ...f.api,
      questions: [
        ...f.api.questions.slice(0, 2),
        {
          label: "Pronouns",
          required: true,
          fields: [
            {
              name: "question_123",
              values: options.map((label) => ({ label })),
            },
          ],
        },
      ],
    };
    const html = `<form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="email">Email</label><input id="email"><label for="question_123">Pronouns</label><select id="question_123">${options.map((value) => `<option>${value}</option>`).join("")}</select></form>`;
    const read = async (u: string) => ({
      ...(await f.read(u)),
      text: u.includes("boards-api") ? JSON.stringify(api) : html,
    });
    const initial = await generateAutofill(f.store, "one", read);
    const question = initial.dynamicQuestions![0];
    const task = f.store.get("task", "task");
    assert.ok(task?.preset === "questions" && task.autofillContext);
    const running = {
      ...task,
      autofillContext: { ...task.autofillContext, questions: [question] },
    };
    f.store.put("task", task.id, running);
    stageApplicationAnswers(f.store, running, {
      answers: [
        {
          fieldId: question.id,
          answer: "",
          needsInput: true,
          sourcePaths: [],
          caveats: ["Confirm the answer"],
          manualReviewRequired: true,
          reviewReason: "Confirm the answer",
        },
      ],
    });
    const staged = f.store.get("task", task.id);
    assert.ok(staged);
    f.store.put("task", task.id, { ...staged, status: "completed" });
    publishApplicationAnswers(f.store, task.id, "turn");
    const draft = await generateAutofill(f.store, "one", read);
    reviewApplicationAnswer(f.store, "one", task.id, question.key, {
      answer: options[0],
      answerHash: draft.dynamicQuestions![0].answerHash,
      scriptId: draft.id,
    });
    atomicWrite(
      path.join(f.root, ".local/greenhouse/profile.json"),
      JSON.stringify({
        version: 1,
        firstName: "Test",
        email: "test@example.com",
        demographics: { pronouns: options[1] },
      }),
    );
    api.content = "Updated job description";
    const next = await generateAutofill(f.store, "one", read);
    const carried = next.dynamicQuestions![0];
    assert.notEqual(carried.key, question.key);
    assert.equal(carried.answer, options[0]);
    assert.equal(
      next.answers.find((a) => a.label === "Pronouns")?.source,
      "user",
    );
    assert.throws(
      () =>
        reviewApplicationAnswer(f.store, "one", task.id, carried.key, {
          answer: "Unavailable option",
          answerHash: carried.answerHash,
          scriptId: next.id,
        }),
      /captured options/,
    );
    reviewApplicationAnswer(f.store, "one", task.id, carried.key, {
      answer: options[1],
      answerHash: carried.answerHash,
      scriptId: next.id,
    });
    const changed = await generateAutofill(f.store, "one", read);
    assert.equal(changed.dynamicQuestions![0].answer, options[1]);
    api.questions = [
      ...api.questions.slice(0, 2),
      {
        label: "Pronouns",
        required: true,
        fields: [{ name: "question_123", values: [{ label: "They/Them" }] }],
      },
    ];
    const removed = await generateAutofill(f.store, "one", read);
    assert.equal(
      removed.answers.some((a) => a.value === options[1]),
      false,
    );
  } finally {
    f.cleanup();
  }
});
