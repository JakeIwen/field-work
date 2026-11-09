import test from "node:test";
import assert from "node:assert/strict";
import {
  attachDocumentReason,
  autofillPreparationView,
} from "../shared/greenhouse-autofill.js";
import { legacyAutofill } from "./fixtures/legacy-records.js";
import type { ApplicationPreparation } from "../shared/application-preparation.js";
import { buildAutofillPlan } from "../server/greenhouse-autofill.js";

const preparation: ApplicationPreparation = {
  id: "run",
  openingId: "one",
  applicationId: "app",
  status: "failed",
  phase: "answers",
  message: "Stopped",
  error: "Profile changed",
  createdAt: "2026-01-01",
  updatedAt: "2026-01-01",
  openingHash: "hash",
  documentIds: ["resume", "letter"],
  taskIds: [],
  supportedForm: true,
};

test("an unfinished preparation is not presented as manual form work or a running answer task", () => {
  const record = legacyAutofill({
    dynamicQuestions: [
      {
        id: "q",
        key: "q",
        label: "Education",
        required: true,
        kind: "select",
        maxLength: 100,
      },
    ],
    review: [
      {
        label: "Education",
        required: true,
        reason: "Codex can interpret this unmatched question...",
      },
      { label: "Resume/CV", required: true, reason: "Attach manually" },
      { label: "Cover letter", required: false, reason: "Attach manually" },
      {
        label: "Privacy agreement",
        required: true,
        reason: "Read and agree yourself",
      },
    ],
    attachments: [],
  });
  const view = autofillPreparationView(record, preparation);
  assert.equal(view.incomplete, true);
  assert.equal(view.retryPreparation, true);
  assert.equal(view.pendingLabel, "Preparation stopped");
  assert.deepEqual(
    view.finishItems.map((r) => r.label),
    ["Privacy agreement"],
  );
  assert.equal(autofillPreparationView(record).pendingLabel, "Not prepared");
  assert.equal(
    autofillPreparationView(record, undefined, true).pendingLabel,
    "Preparing answer",
  );
});

test("a script saved without a preparation still needs Generate Docs when the form asks for documents", () => {
  const review = [
    { label: "Resume/CV", required: true, reason: attachDocumentReason },
    { label: "Cover letter", required: false, reason: attachDocumentReason },
    { label: "Privacy agreement", required: true, reason: "Agree yourself" },
  ];
  const view = autofillPreparationView(
    legacyAutofill({ review, attachments: [] }),
  );
  assert.equal(view.incomplete, true);
  assert.equal(view.retryPreparation, true);
  assert.deepEqual(
    view.finishItems.map((r) => r.label),
    ["Privacy agreement"],
  );
  const attached = autofillPreparationView(
    legacyAutofill({
      review: review.slice(1),
      attachments: [
        {
          id: "resume",
          label: "Resume/CV",
          documentId: "doc",
          name: "resume.pdf",
          hash: "hash",
          mime: "application/pdf",
          size: 1,
        },
      ],
    }),
  );
  assert.equal(attached.incomplete, false);
  assert.equal(attached.retryPreparation, false);
});

test("explicit manual-review questions remain visible and reviewed answers are not pending", () => {
  const record = legacyAutofill({
    dynamicQuestions: [
      {
        id: "q",
        key: "q",
        label: "Visa",
        required: true,
        kind: "select",
        maxLength: 100,
        needsInput: true,
        manualReviewRequired: true,
      },
    ],
    review: [
      {
        label: "Visa",
        required: true,
        reason: "Confirm the employer's additional conditions",
      },
    ],
  });
  const view = autofillPreparationView(record);
  assert.equal(view.incomplete, false);
  assert.equal(view.finishItems.length, 1);
});

test("Fabrikam-style education, discovery and work authorization use saved facts without guessing expanded visa conditions", () => {
  const labels = [
    "Are you currently authorized to work in the city/country where this position is located?",
    "How did you hear about Fabrikam?",
    "What is the highest level of education you have obtained?",
    "If yes, will you now or in the future require Fabrikam to file a petition or application for employment-based visa status on your behalf? (OPT or other EAD status must answer YES.)",
  ];
  const values = [
    ["Yes", "No"],
    ["Fabrikam Employee", "LinkedIn", "Other"],
    ["Associate’s Degree", "Bachelor’s Degree", "Master’s Degree"],
    ["Yes", "No"],
  ];
  const api = {
    company_name: "Fabrikam Corporation",
    location: { name: "United States" },
    offices: [{ name: "Fabrikam Corporation - US", location: null }],
    questions: labels.map((label, i) => ({
      label,
      required: true,
      fields: [
        {
          name: `question_${i}`,
          values: values[i].map((label) => ({ label })),
        },
      ],
    })),
  };
  const html = `<form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="email">Email</label><input id="email">${labels.map((label, i) => `<label for="question_${i}">${label}</label><input id="question_${i}" role="combobox">`).join("")}</form>`;
  const profile = {
    authorizedToWorkUS: true,
    requiresSponsorshipNowOrFuture: false,
    discoverySource: { strategy: "hosting-service-search" },
    resumeFacts: { highestDegreeRank: 3 },
  };
  const plan = buildAutofillPlan(
    "https://job-boards.greenhouse.io/fabrikam/jobs/123",
    html,
    api,
    profile,
  );
  assert.deepEqual(
    plan.fields.map((f) => f.value),
    ["Yes", "Other", "Bachelor’s Degree"],
  );
  const foreign = buildAutofillPlan(
    "https://job-boards.greenhouse.io/fabrikam/jobs/123",
    html,
    { ...api, location: { name: "Canada" } },
    profile,
  );
  assert.equal(
    foreign.fields.find((f) => f.id === "question_0")?.value,
    "Yes",
    "work permission never depends on the job's country",
  );
  assert.equal(
    plan.fields.some((f) => f.id === "question_3"),
    false,
  );
});
