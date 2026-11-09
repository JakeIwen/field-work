import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store, atomicWrite } from "../server/storage.js";
import {
  generateAutofill,
  savedAutofillScript,
  readAutofillProfile,
} from "../server/greenhouse-autofill.js";
import {
  unmatchedQuestion,
  validateApplicationAnswers,
  stageApplicationAnswers,
  publishApplicationAnswers,
  reviewApplicationAnswer,
} from "../server/application-answers.js";
import {
  prepareQuestionBundle,
  questionPrompt,
  questionReferenceId,
} from "../server/question-context.js";
import { contextTool } from "../server/context-tools.js";

const taskId = "11111111-1111-4111-8111-111111111111";
const url = "https://job-boards.greenhouse.io/example/jobs/123";
const label =
  "Which description of your preferred communication style best matches your pronouns?";
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "unmatched-answers-"));
  const store = new Store(root, path.join(root, ".local/data"));
  const paths = [
    "AGENTS.md",
    "source_data/README.md",
    "source_data/resume.md",
    "source_data/github_evidence_dossier.md",
  ];
  for (const p of paths)
    atomicWrite(path.join(root, p), "Synthetic evidence only.");
  atomicWrite(
    path.join(root, ".local/greenhouse/profile.json"),
    JSON.stringify({
      version: 1,
      firstName: "Test",
      email: "test@example.com",
      demographics: { pronouns: "They/Them", transgender: null },
      discoverySource: { employeeReferral: false },
    }),
  );
  store.put(
    "cache_opening",
    "one" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
    {
      id: "one",
      company_id: "example",
      company: "Example",
      url,
      hash: "opening",
    } as Records["cache_opening"],
  );
  const api = {
    id: 123,
    title: "Engineer",
    company_name: "Example",
    location: { name: "United States" },
    questions: [
      { label: "First Name", fields: [{ name: "first_name" }] },
      { label: "Email", fields: [{ name: "email" }] },
      {
        label,
        required: true,
        fields: [
          {
            name: "question_123",
            values: [
              { label: "Use they/them when referring to me" },
              { label: "Use she/her when referring to me" },
            ],
          },
        ],
      },
    ],
  };
  const html = `<form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="email">Email</label><input id="email"><label for="question_123">${label}</label><input id="question_123" role="combobox"></form>`;
  const read = async (u: string) => ({
    url: u,
    requestedUrl: u,
    status: 200,
    type: "text/html",
    text: u.includes("boards-api") ? JSON.stringify(api) : html,
    at: new Date().toISOString(),
  });
  return {
    root,
    store,
    api,
    read,
    paths,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("unmatched identity binds choices and profile; consent and unsupported choices stay outside model automation", () => {
  const f = {
    id: "q",
    label: "Choose your preferred pronouns",
    kind: "select",
    required: true,
    options: ["A", "B"],
  };
  const q = unmatchedQuestion(f, url, "profile-1")!;
  assert.equal(q.profileOnly, true);
  assert.equal(q.mode, "unmatched");
  assert.notEqual(
    q.key,
    unmatchedQuestion({ ...f, options: ["A", "C"] }, url, "profile-1")!.key,
  );
  assert.notEqual(q.key, unmatchedQuestion(f, url, "profile-2")!.key);
  assert.notEqual(
    unmatchedQuestion(f, url, "p", "us-posting")!.key,
    unmatchedQuestion(f, url, "p", "changed-country")!.key,
  );
  assert.notEqual(
    q.key,
    unmatchedQuestion(
      { ...f, description: "A qualifier changes the question." },
      url,
      "profile-1",
    )!.key,
  );
  assert.equal(
    unmatchedQuestion(
      { ...f, label: "I consent to personal data processing" },
      url,
      "p",
    ),
    null,
  );
  assert.equal(unmatchedQuestion({ ...f, kind: "file" }, url, "p"), null);
  assert.equal(unmatchedQuestion({ ...f, options: [] }, url, "p"), null);
});

test("final-pass results use exact choices and explicit profile facts, then publish into scripts and reuse safely", async () => {
  const f = fixture();
  try {
    const initial = await generateAutofill(f.store, "one", f.read);
    const q = initial.dynamicQuestions!.find((q) => q.id === "question_123")!;
    assert.equal(q.mode, "unmatched");
    assert.equal(q.profileOnly, true);
    assert.equal(
      initial.answers.some((a) => a.label === label),
      false,
    );
    const profile = readAutofillProfile(f.store);
    const task: any = {
      id: taskId,
      threadId: "thread",
      status: "running",
      activeTurnId: "turn",
      preset: "questions",
      context: { openingId: "one" },
      autofillContext: {
        url,
        questions: [q],
        knowledgeHash: initial.knowledgeHash,
        profileHash: profile.hash,
        profileSnapshot: profile.profile,
      },
    };
    const prepared = prepareQuestionBundle(f.store, task, {
      id: questionReferenceId,
      text: "Synthetic historical context",
      limits: "No additional facts.",
    });
    task.manifest = prepared.manifest;
    assert.ok(task.manifest.paths.includes("confirmed-profile.json"));
    assert.match(questionPrompt(task), /final interpretation pass/);
    assert.equal(
      JSON.parse(
        readFileSync(path.join(prepared.cwd, "confirmed-profile.json"), "utf8"),
      ).demographics.pronouns,
      "They/Them",
    );
    assert.equal(
      JSON.parse(
        readFileSync(
          path.join(prepared.cwd, "application-questions.json"),
          "utf8",
        ),
      ).profileSnapshot,
      undefined,
    );
    f.store.put("task", taskId, task);
    assert.equal(
      // The context must exist with its snapshot stripped; a missing context must still fail.
      f.store.state().tasks[0].autofillContext!.profileSnapshot,
      undefined,
    );
    const answer = {
      fieldId: q.id,
      answer: q.options![0],
      needsInput: false,
      sourcePaths: ["confirmed-profile.json"],
      profileKeys: ["demographics.pronouns"],
      caveats: [],
      manualReviewRequired: false,
      reviewReason: "",
    };
    assert.equal(
      contextTool(f.store, "thread", "save_application_answers", {
        answers: [answer],
      }).saved,
      true,
    );
    f.store.put(
      "task",
      taskId /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...f.store.get("task", taskId),
        status: "completed",
      } as Records["task"],
    );
    publishApplicationAnswers(f.store, taskId, "turn");
    const ready = await generateAutofill(f.store, "one", f.read);
    assert.equal(
      ready.answers.find((a) => a.label === label)?.value,
      q.options![0],
    );
    assert.equal(
      ready.review.some((r) => r.label === label),
      false,
    );
    assert.equal(
      ready.dynamicQuestions!.find((q) => q.id === "question_123")!.taskId,
      taskId,
    );
    assert.ok(
      savedAutofillScript(f.store, "one", ready.id).script.includes(
        q.options![0],
      ),
    );
    const saved = ready.dynamicQuestions!.find((q) => q.id === "question_123")!;
    assert.throws(
      () =>
        reviewApplicationAnswer(f.store, "one", taskId, q.key, {
          answer: "Invented option",
          answerHash: saved.answerHash,
        }),
      /captured options/,
    );
    for (const patch of [
      { answer: "Invented option" },
      { profileKeys: [] },
      { profileKeys: ["demographics.transgender"] },
      { profileKeys: ["demographics.missing"] },
      { sourcePaths: [f.paths[3]], profileKeys: [] },
      { notApplicable: true, answer: "" },
    ])
      assert.throws(() =>
        validateApplicationAnswers(task, {
          answers: [{ ...answer, ...patch }],
        }),
      );
    atomicWrite(
      path.join(f.root, ".local/greenhouse/profile.json"),
      JSON.stringify({
        version: 1,
        firstName: "Test",
        email: "test@example.com",
        demographics: { pronouns: "She/Her" },
      }),
    );
    assert.throws(
      () => publishApplicationAnswers(f.store, taskId, "turn"),
      /profile changed/,
    );
    const changed = await generateAutofill(f.store, "one", f.read);
    assert.equal(
      changed.answers.some((a) => a.label === label),
      false,
    );
  } finally {
    f.close();
  }
});

test("missing facts stay manual and a supported optional omission leaves the field blank", () => {
  const base = {
    id: "q",
    label: "Describe your citizenship status",
    kind: "text",
    required: true,
    maxLength: 100,
  };
  const q = unmatchedQuestion(base, url, "profile")!;
  const task: any = {
    manifest: { paths: ["confirmed-profile.json"] },
    autofillContext: {
      questions: [q],
      profileSnapshot: { discoverySource: { employeeReferral: false } },
    },
  };
  const unresolved = {
    fieldId: "q",
    answer: "",
    needsInput: true,
    sourcePaths: [],
    profileKeys: [],
    caveats: [
      "Please confirm citizenship; work authorization does not establish citizenship.",
    ],
    manualReviewRequired: true,
    reviewReason: "Citizenship has not been supplied.",
  };
  assert.equal(
    validateApplicationAnswers(task, { answers: [unresolved] })[0].needsInput,
    true,
  );
  const trans = unmatchedQuestion(
    {
      ...base,
      label: "Do you identify as transgender?",
      kind: "select",
      options: ["Yes", "No"],
    },
    url,
    "profile",
  )!;
  task.autofillContext.questions = [trans];
  task.autofillContext.profileSnapshot.demographics = {
    gender: "Male",
    transgender: null,
  };
  assert.throws(
    () =>
      validateApplicationAnswers(task, {
        answers: [
          {
            ...unresolved,
            answer: "No",
            needsInput: false,
            manualReviewRequired: false,
            reviewReason: "",
            sourcePaths: ["confirmed-profile.json"],
            profileKeys: ["demographics.gender"],
          },
        ],
      }),
    /own confirmed/,
  );
  task.autofillContext.questions = [
    unmatchedQuestion(
      { ...base, label: "What is your ZIP code?" },
      url,
      "profile",
    )!,
  ];
  task.autofillContext.profileSnapshot.location = { city: "Example City" };
  assert.throws(
    () =>
      validateApplicationAnswers(task, {
        answers: [
          {
            ...unresolved,
            answer: "12345",
            needsInput: false,
            manualReviewRequired: false,
            reviewReason: "",
            sourcePaths: ["confirmed-profile.json"],
            profileKeys: ["location.city"],
          },
        ],
      }),
    /own confirmed/,
  );
  const optional = unmatchedQuestion(
    {
      ...base,
      label: "Name the colleague who recommended this application",
      required: false,
    },
    url,
    "profile",
  )!;
  task.autofillContext.questions = [optional];
  const omitted = {
    ...unresolved,
    needsInput: false,
    notApplicable: true,
    sourcePaths: ["confirmed-profile.json"],
    profileKeys: ["discoverySource.employeeReferral"],
    manualReviewRequired: false,
    reviewReason: "",
  };
  assert.equal(
    validateApplicationAnswers(task, { answers: [omitted] })[0].notApplicable,
    true,
  );
  assert.throws(() =>
    validateApplicationAnswers(task, {
      answers: [{ ...omitted, profileKeys: ["constructor"] }],
    }),
  );
});

test("narrow declarations and recruiting preferences require their own saved facts", () => {
  const profile = {
    demographics: {
      disability: false,
      physicalDisability: true,
      veteran: true,
      activeMilitary: false,
      everMilitaryService: true,
    },
    location: { state: "WA", postalCode: "00000" },
    preferences: {
      recruitingSms: true,
      otherPositions: true,
      interviewRecording: null,
    },
  };
  const cases = [
    [
      "I have a physical disability",
      "demographics.physicalDisability",
      "demographics.disability",
      "Yes",
    ],
    [
      "Have you ever served in the military?",
      "demographics.everMilitaryService",
      "demographics.veteran",
      "Yes",
    ],
    ["Zipcode", "location.postalCode", "location.state", "00000"],
    [
      "Would you like recruiting communications via SMS?",
      "preferences.recruitingSms",
      "preferences.otherPositions",
      "Yes",
    ],
    [
      "Would you like to be considered for other positions now or in the future?",
      "preferences.otherPositions",
      "preferences.recruitingSms",
      "Yes",
    ],
  ];
  for (const [label, key, adjacent, answer] of cases) {
    const question = unmatchedQuestion(
      { id: "q", label, kind: "text", required: true },
      url,
      "profile",
    )!;
    const task: any = {
      manifest: { paths: ["confirmed-profile.json"] },
      autofillContext: { questions: [question], profileSnapshot: profile },
    };
    const result = {
      fieldId: "q",
      answer,
      needsInput: false,
      sourcePaths: ["confirmed-profile.json"],
      profileKeys: [key],
      caveats: [],
      manualReviewRequired: false,
      reviewReason: "",
    };
    assert.equal(
      validateApplicationAnswers(task, { answers: [result] })[0].answer,
      answer,
    );
    assert.throws(
      () =>
        validateApplicationAnswers(task, {
          answers: [{ ...result, profileKeys: [adjacent] }],
        }),
      /own confirmed/,
    );
    assert.throws(
      () =>
        validateApplicationAnswers(task, {
          answers: [
            { ...result, profileKeys: ["preferences.interviewRecording"] },
          ],
        }),
      /non-null/,
    );
  }
});
