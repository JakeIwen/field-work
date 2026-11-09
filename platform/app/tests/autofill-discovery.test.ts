import test from "node:test";
import assert from "node:assert/strict";
import {
  discoveryAnswer,
  isDiscoveryQuestion,
} from "../server/autofill/discovery.js";
import { buildAutofillPlan } from "../server/greenhouse-autofill.js";

const profile = {
  firstName: "Test",
  email: "test@example.com",
  discoverySource: { strategy: "hosting-service-search" },
};
test("confirmed service-search preference handles source question variants without inventing referrers", () => {
  for (const label of [
    "How did you hear about this role?",
    "Where did you find this job?",
    "How did you learn of this opportunity?",
    "How did you hear about us? (Select all that apply)",
    "Referral source",
  ])
    assert.equal(
      discoveryAnswer(label, undefined, profile, "Greenhouse.io"),
      "Search on Greenhouse.io",
      label,
    );
  assert.equal(
    discoveryAnswer(
      "How did you hear about Contoso?",
      undefined,
      profile,
      "Greenhouse.io",
      "Contoso, Inc.",
    ),
    "Search on Greenhouse.io",
  );
  for (const label of [
    "Who referred you?",
    "Employee referral name",
    "Why do you want this role?",
    "How did you hear about us and why did you apply?",
  ])
    assert.equal(isDiscoveryQuestion(label), false);
  assert.equal(
    discoveryAnswer(
      "How did you hear about us?",
      undefined,
      {},
      "Greenhouse.io",
    ),
    null,
  );
});
test("choices prefer the actual service and never substitute an unconfirmed site or employee", () => {
  const q = "How did you hear about us?";
  assert.equal(
    discoveryAnswer(
      q,
      ["Other", "Job board", "Greenhouse.io"],
      profile,
      "Greenhouse.io",
    ),
    "Greenhouse.io",
  );
  assert.equal(
    discoveryAnswer(
      q,
      ["LinkedIn", "Job board", "Other"],
      profile,
      "Greenhouse.io",
    ),
    "Job board",
  );
  assert.equal(
    discoveryAnswer(q, ["Online search", "Other"], profile, "Greenhouse.io"),
    "Online search",
  );
  assert.equal(
    discoveryAnswer(
      q,
      ["Other Job Board", "Other Website", "LinkedIn"],
      profile,
      "Greenhouse.io",
    ),
    "Other Job Board",
  );
  assert.equal(
    discoveryAnswer(
      q,
      ["Careers website", "Employee referral", "Other"],
      profile,
      "Greenhouse.io",
    ),
    "Other",
  );
  assert.equal(
    discoveryAnswer(
      q,
      ["LinkedIn", "Indeed", "Employee referral"],
      profile,
      "Greenhouse.io",
    ),
    null,
  );
  assert.equal(
    discoveryAnswer(
      q,
      ["Greenhouse", "Greenhouse.io", "Other"],
      profile,
      "Greenhouse.io",
    ),
    null,
  );
});
test("text and grouped source controls enter the execution plan; unrelated declarations stay manual", () => {
  const api = {
    company_name: "Example",
    questions: [
      { label: "First Name", fields: [{ name: "first_name" }] },
      { label: "Email", fields: [{ name: "email" }] },
      {
        label: "How did you hear about this role?",
        required: true,
        fields: [{ name: "question_1", type: "input_text" }],
      },
      {
        label: "How did you hear about us?",
        required: true,
        fields: [
          {
            name: "question_2[]",
            type: "multi_value_multi_select",
            values: [
              { label: "Indeed", value: 1 },
              { label: "Other", value: 2 },
            ],
          },
        ],
      },
      {
        label: "I consent to data processing",
        required: true,
        fields: [
          {
            name: "consent",
            type: "multi_value_single_select",
            values: [{ label: "Yes", value: 1 }],
          },
        ],
      },
    ],
  };
  const html =
    '<form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="email">Email</label><input id="email"><label for="question_1">How did you hear about this role?</label><input id="question_1"><label for="indeed">Indeed</label><input id="indeed" name="question_2[]" type="checkbox"><label for="other">Other</label><input id="other" name="question_2[]" type="checkbox"><label for="consent">I consent to data processing</label><input id="consent" name="consent" type="checkbox"></form>';
  const plan = buildAutofillPlan(
    "https://job-boards.greenhouse.io/example/jobs/123",
    html,
    api,
    profile,
  );
  assert.equal(
    plan.fields.find((f) => f.id === "question_1")?.value,
    "Search on Greenhouse.io",
  );
  assert.equal(plan.fields.find((f) => f.id === "other")?.kind, "checkbox");
  assert.equal(plan.fields.find((f) => f.id === "other")?.value, "Other");
  assert.equal(
    plan.fields.some((f) => f.id === "consent" || f.id === "indeed"),
    false,
  );
  assert.equal(
    plan.review.some((r) => r.label === "How did you hear about us?"),
    false,
  );
  assert.equal(plan.dynamicQuestions.length, 0);
});
