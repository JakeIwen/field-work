import test from "node:test";
import assert from "node:assert/strict";
import { directAutofillRule } from "../server/autofill/plan-rules.js";

const profile = { preferences: { recruitingSms: true } };
const posting = { content: "", compensation: undefined } as any;
const ask = (
  label: string,
  options = ["Yes", "No"],
  description?: string,
  saved: any = profile,
) =>
  directAutofillRule(
    {
      id: "question_1",
      label,
      kind: "select",
      required: true,
      options,
      ...(description ? { description } : {}),
    },
    posting,
    saved,
    "Example",
  ).answer?.value;

test("recruiter text opt-ins follow the saved SMS preference", () => {
  assert.equal(
    ask(
      "Would you like to opt-in to receiving text messages from the recruiter for this role in relation to the hiring process – such as interview requests, reminders, etc.?",
      ["Yes", "No"],
      "Note: Selecting “no” will not eliminate you from consideration for this role.Message and data rates may apply, depending on your mobile phone service plan. At any time you can get more help by replying HELP to these texts, or you can opt out completely by replying STOP.",
    ),
    "Yes",
  );
  assert.equal(
    ask(
      "Would you like to opt-in to receiving text messages for this role regarding the hiring process (e.g., interview scheduling)?",
      ["Yes, opt me in", "No thanks"],
    ),
    "Yes, opt me in",
  );
  assert.equal(
    ask(
      "Would you like to opt-in to receiving text messages from the recruiter for this role?",
      ["Yes", "No"],
      undefined,
      { preferences: { recruitingSms: null } },
    ),
    undefined,
  );
});

test("marketing texts and bundled declarations stay manual", () => {
  for (const label of [
    "Would you like to opt-in to receiving text messages about future roles and job alerts?",
    "Would you like to opt-in to receiving marketing text messages from our recruiting team?",
    "I agree to receive text messages about my application and accept the privacy policy",
    "Do you consent to a background check and to receiving texts about this role?",
  ])
    assert.equal(ask(label), undefined, label);
});
