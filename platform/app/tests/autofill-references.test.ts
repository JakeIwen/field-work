import test from "node:test";
import assert from "node:assert/strict";
import { suggestAutofill } from "../server/greenhouse-autofill.js";
import {
  unmatchedQuestion,
  validateApplicationAnswers,
} from "../server/application-answers.js";

const profile = {
  firstName: "Test",
  lastName: "Applicant",
  email: "applicant@example.com",
  phone: "5550000000",
  preferences: { professionalReferences: true, contactReferences: true },
  references: [
    {
      name: "Pat Example",
      title: "Engineering Lead",
      company: "Example Co.",
      email: "pat@example.com",
      phone: "5551234567",
      relationship: "Former manager",
    },
  ],
};
const ask = (
  label: string,
  kind: "text" | "textarea" | "select" = "text",
  options: string[] = [],
  saved: any = profile,
  semanticRole?: "phone" | "email" | "full-name",
) =>
  suggestAutofill(
    {
      id: "question_1",
      label,
      kind,
      required: false,
      options,
      ...(semanticRole ? { semanticRole } : {}),
    },
    saved,
    "Example",
  )?.value;

test("reference detail fields use the saved reference, never the applicant", () => {
  assert.equal(ask("Reference name"), "Pat Example");
  assert.equal(ask("Reference 1 - Full Name"), "Pat Example");
  assert.equal(ask("Reference email address"), "pat@example.com");
  assert.equal(
    ask("Reference phone number", "text", [], profile, "phone"),
    "5551234567",
  );
  assert.equal(ask("Reference company name"), "Example Co.");
  assert.equal(ask("Reference job title"), "Engineering Lead");
  assert.equal(ask("Relationship to reference"), "Former manager");
  assert.equal(
    ask("Reference title and company"),
    "Engineering Lead, Example Co.",
  );
  // A second reference was never saved, and a typed phone field must not
  // fall back to the applicant's own number.
  assert.equal(
    ask("Reference 2 phone", "text", [], profile, "phone"),
    undefined,
  );
  assert.equal(ask("Second reference name"), undefined);
  const { references: _, ...withoutReferences } = profile;
  assert.equal(
    ask("Reference phone", "text", [], withoutReferences, "phone"),
    undefined,
  );
});

test("a references field gets the full contact block in its field shape", () => {
  assert.equal(
    ask("Professional references", "textarea"),
    "Pat Example\nEngineering Lead, Example Co.\nEmail: pat@example.com\nPhone: (555) 123-4567\nRelationship: Former manager",
  );
  assert.equal(
    ask("Please provide a professional reference"),
    "Pat Example; Engineering Lead, Example Co.; Email: pat@example.com; Phone: (555) 123-4567; Relationship: Former manager",
  );
  assert.equal(
    ask("Please list three professional references", "textarea"),
    undefined,
  );
});

test("willingness and contact permission follow their own saved preferences", () => {
  assert.equal(
    ask("Are you willing to provide professional references?", "select", [
      "Yes",
      "No",
    ]),
    "Yes",
  );
  assert.equal(
    ask(
      "Are you willing to provide professional references?",
      "select",
      ["Yes", "No"],
      {
        ...profile,
        preferences: { professionalReferences: null },
      },
    ),
    undefined,
  );
  for (const label of [
    "May we contact your references?",
    "Do you authorize us to contact your references?",
    "Can we reach out to the references you listed?",
  ])
    assert.equal(ask(label, "select", ["Yes", "No"]), "Yes", label);
  const providesOnly = {
    ...profile,
    preferences: { professionalReferences: true },
  };
  assert.equal(
    ask(
      "May we contact your references?",
      "select",
      ["Yes", "No"],
      providesOnly,
    ),
    undefined,
  );
  for (const label of [
    "May we contact your references and run a background check?",
    "When may we contact your references?",
    "Do you consent to a credit check?",
    "What would your references say about you?",
  ])
    assert.equal(ask(label, "textarea"), undefined, label);
  // Employee referrals and requisition numbers are not professional references.
  assert.equal(ask("Job reference number"), undefined);
});

test("an unmatched contact-permission answer must cite that permission", () => {
  const question = unmatchedQuestion(
    {
      id: "q",
      label: "Is it okay for us to contact your references?",
      kind: "text",
      required: true,
    },
    "https://job-boards.greenhouse.io/example/jobs/123",
    "profile",
  )!;
  const task: any = {
    manifest: { paths: ["confirmed-profile.json"] },
    autofillContext: { questions: [question], profileSnapshot: profile },
  };
  const result = {
    fieldId: "q",
    answer: "Yes",
    needsInput: false,
    sourcePaths: ["confirmed-profile.json"],
    profileKeys: ["preferences.contactReferences"],
    caveats: [],
    manualReviewRequired: false,
    reviewReason: "",
  };
  assert.equal(
    validateApplicationAnswers(task, { answers: [result] })[0].answer,
    "Yes",
  );
  assert.throws(
    () =>
      validateApplicationAnswers(task, {
        answers: [
          { ...result, profileKeys: ["preferences.professionalReferences"] },
        ],
      }),
    /own confirmed/,
  );
});

test("unmatched reference answers must cite the saved reference", () => {
  const question = unmatchedQuestion(
    { id: "q", label: "Reference phone number", kind: "text", required: true },
    "https://job-boards.greenhouse.io/example/jobs/123",
    "profile",
  )!;
  const task: any = {
    manifest: { paths: ["confirmed-profile.json"] },
    autofillContext: { questions: [question], profileSnapshot: profile },
  };
  const result = {
    fieldId: "q",
    answer: "5551234567",
    needsInput: false,
    sourcePaths: ["confirmed-profile.json"],
    profileKeys: ["references.0.phone"],
    caveats: [],
    manualReviewRequired: false,
    reviewReason: "",
  };
  assert.equal(
    validateApplicationAnswers(task, { answers: [result] })[0].answer,
    "5551234567",
  );
  assert.throws(
    () =>
      validateApplicationAnswers(task, {
        answers: [{ ...result, answer: "5550000000", profileKeys: ["phone"] }],
      }),
    /saved professional reference/,
  );
  assert.throws(
    () =>
      validateApplicationAnswers(task, {
        answers: [{ ...result, profileKeys: ["references.1.phone"] }],
      }),
    /non-null/,
  );
});
