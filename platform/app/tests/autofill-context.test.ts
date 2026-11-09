import test from "node:test";
import assert from "node:assert/strict";
import { autofillLocation } from "../server/autofill/location.js";
import { buildAutofillPlan } from "../server/greenhouse-autofill.js";
import { buildAutofillContext } from "../server/task-kinds/autofill-answers.js";
import {
  narrativeQuestion,
  validateApplicationAnswers,
} from "../server/application-answers.js";

const url = "https://job-boards.greenhouse.io/example/jobs/123";
const profile = {
  firstName: "Test",
  authorizedToWorkUS: true,
  requiresSponsorshipNowOrFuture: false,
  applicationLocation: {
    country: "US",
    state: "WA",
    remoteRolesWithoutRelocationAssistance: true,
  },
  employmentHistory: {
    currentOrFormerEmployee: false,
    currentEmployer: "Example Corp",
    currentJobTitle: "Platform Engineer",
  },
};
const labels = [
  "First Name",
  "Have you been employed by Example before?",
  "If offered this position would you be able to fill the position in one of the countries listed on the job posting without relocation assistance from Example?",
  "Are you authorized to work lawfully in the country to which you are applying for Example?",
  "(Skip this question if you are applying to work in Canada or the UK). Do you now or in the future require sponsorship?",
  "Applicant Privacy Notice",
  "Current Employer",
  "Current Job Title",
];
const fields = labels.map((label, i) => ({
  label,
  required: i !== 4,
  ...(i === 5
    ? {
        description:
          "I have received, read and understand the privacy notice for job applicants.",
      }
    : {}),
  fields: [
    {
      name: i === 0 ? "first_name" : `question_${i}`,
      ...(i > 0 && i < 6
        ? {
            values: (i === 5 ? ["Yes"] : ["Yes", "No"]).map((label) => ({
              label,
            })),
          }
        : {}),
    },
  ],
}));
const api = {
  title: "Engineer",
  content: "A remote engineering role.",
  location: { name: "Remote" },
  offices: [{ name: "Remote Canada", location: null }],
  questions: fields,
};
const html = `<form id="application-form"><label for="email">Email</label><input id="email">${fields.map((f) => `<label for="${f.fields[0].name}">${f.label}</label><input id="${f.fields[0].name}" ${f.fields[0].values ? 'role="combobox"' : ""}>`).join("")}</form>`;

test("generic Remote preserves Canada office restrictions and reuses confirmed employment answers", () => {
  const plan = buildAutofillPlan(url, html, api, profile);
  const values = new Map(plan.fields.map((f) => [f.label, f.value]));
  assert.equal(values.get(labels[1]), "No");
  assert.equal(values.get("Current Employer"), "Example Corp");
  assert.equal(values.get("Current Job Title"), "Platform Engineer");
  // Work permission never depends on the job's country.
  assert.equal(values.get(labels[3]), "Yes");
  assert.equal(
    plan.dynamicQuestions.some((q) => q.label === labels[4]),
    false,
  );
  assert.equal(
    plan.review.some((q) => q.label === labels[4]),
    false,
  );
  assert.equal(
    plan.dynamicQuestions.some((q) => q.label === labels[5]),
    false,
  );
  assert.match(
    plan.review.find((q) => q.label === labels[5])!.reason,
    /yourself/,
  );
  const context = buildAutofillContext(
    { id: "script", url, title: "Engineer", createdAt: "2026-10-01" },
    plan.dynamicQuestions,
    { api, profile },
    { profile, hash: "profile" },
  );
  assert.equal(context.postingCountry, "CA");
  assert.equal(context.locationContext.countryMismatch, true);
  assert.deepEqual(context.locationContext.offices, [
    { name: "Remote Canada", location: "" },
  ]);
  assert.equal(
    context.profileSnapshot?.employmentHistory.currentEmployer,
    "Example Corp",
  );
});

test("US office evidence enables country-bound facts and changed offices invalidate unmatched answers", () => {
  const usApi = { ...api, offices: [{ name: "Remote US", location: null }] };
  const us = buildAutofillPlan(url, html, usApi, profile);
  assert.equal(us.fields.find((f) => f.label === labels[3])?.value, "Yes");
  const ca = buildAutofillPlan(url, html, api, profile);
  assert.notEqual(
    us.dynamicQuestions.find((q) => q.label === labels[2])!.key,
    ca.dynamicQuestions.find((q) => q.label === labels[2])!.key,
  );
  assert.equal(
    autofillLocation({ location: { name: "Remote" } }, profile)
      .applicationCountry,
    null,
  );
  assert.equal(
    autofillLocation({ ...api, location: { name: "US" } }, profile)
      .applicationCountry,
    null,
  );
  const multi = {
    ...api,
    offices: [{ name: "Remote US" }, { name: "Remote Canada" }],
  };
  assert.equal(autofillLocation(multi, profile).applicationCountry, "US");
  assert.equal(autofillLocation(multi, {}).applicationCountry, null);
  assert.equal(
    autofillLocation({ ...multi, location: { name: "Onsite" } }, profile)
      .applicationCountry,
    null,
  );
  assert.equal(
    autofillLocation(
      { ...multi, offices: [...multi.offices, { name: "Remote Germany" }] },
      profile,
    ).applicationCountry,
    null,
  );
});

test("unknown employment is not inferred and descriptive privacy acknowledgement stays manual", () => {
  const plan = buildAutofillPlan(url, html, api, {
    firstName: "Test",
    employmentHistory: { currentEmployer: null, currentJobTitle: null },
  });
  assert.equal(
    plan.fields.some(
      (f) => f.label === "Current Employer" || f.label === "Current Job Title",
    ),
    false,
  );
  assert.equal(
    narrativeQuestion(
      {
        id: "question_9",
        label: "What is your answer?",
        description: "I acknowledge the applicant privacy notice.",
        kind: "text",
        required: true,
      },
      url,
    ),
    null,
  );
});

test("model validation accepts saved work permission for any job or question country", () => {
  const q = {
    id: "question_3",
    key: "question_3",
    label: labels[3],
    kind: "select" as const,
    required: true,
    maxLength: 100,
    mode: "unmatched" as const,
    options: ["Yes", "No"],
    profileOnly: true,
  };
  const context = buildAutofillContext(
    { id: "script", url },
    [q],
    { api, profile },
    { profile, hash: "profile" },
  );
  const task = {
    autofillContext: context,
    manifest: { paths: ["confirmed-profile.json"] },
  };
  const answer = {
    fieldId: q.id,
    answer: "Yes",
    needsInput: false,
    manualReviewRequired: false,
    reviewReason: "",
    sourcePaths: ["confirmed-profile.json"],
    profileKeys: ["authorizedToWorkUS"],
    caveats: [],
  };
  assert.equal(context.postingCountry, "CA");
  assert.equal(
    validateApplicationAnswers(task, { answers: [answer] })[0].answer,
    "Yes",
  );
  const canada = {
    ...q,
    label: "Are you authorized to work lawfully in Canada?",
  };
  assert.equal(
    validateApplicationAnswers(
      { ...task, autofillContext: { ...context, questions: [canada] } },
      { answers: [answer] },
    )[0].answer,
    "Yes",
  );
  assert.throws(
    () =>
      validateApplicationAnswers(task, {
        answers: [{ ...answer, profileKeys: ["applicationLocation.country"] }],
      }),
    /own confirmed/,
  );
  assert.equal(
    validateApplicationAnswers(
      { ...task, autofillContext: { ...context, postingCountry: "US" } },
      { answers: [answer] },
    )[0].answer,
    "Yes",
  );
});

test("US job offices corroborate city/state lists without accepting unknown or conflicting regions", () => {
  const location = { name: "Remote - Austin, TX - Denver, CO - Tampa, FL" };
  const officeApi = { ...api, location, offices: [{ name: "United States" }] };
  assert.equal(autofillLocation(officeApi, profile).applicationCountry, "US");
  for (const alternative of [
    { ...officeApi, offices: [] },
    { ...officeApi, offices: [{ name: "Canada" }] },
    { ...officeApi, offices: [{ name: "United States" }, { name: "Canada" }] },
    { ...officeApi, location: { name: "Remote - Austin, TX - Toronto, ON" } },
    { ...officeApi, location: { name: "Remote - Austin, TX - London" } },
  ])
    assert.equal(
      autofillLocation(alternative, profile).applicationCountry,
      null,
    );
  const question = {
    id: "visa",
    key: "visa",
    label:
      "Will you now or in the future require a Visa sponsorship for employment?",
    kind: "select",
    required: true,
    maxLength: 100,
    mode: "unmatched",
    options: ["Yes", "No"],
    profileOnly: true,
  };
  const context = buildAutofillContext(
    { id: "script", url },
    [question],
    { api: officeApi, profile },
    { profile, hash: "profile" },
  );
  assert.equal(
    validateApplicationAnswers(
      {
        autofillContext: context,
        manifest: { paths: ["confirmed-profile.json"] },
      },
      {
        answers: [
          {
            fieldId: question.id,
            answer: "No",
            needsInput: false,
            manualReviewRequired: false,
            reviewReason: "",
            sourcePaths: ["confirmed-profile.json"],
            profileKeys: ["requiresSponsorshipNowOrFuture"],
            caveats: [],
          },
        ],
      },
    )[0].answer,
    "No",
  );
});
