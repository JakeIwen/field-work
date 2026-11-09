import test from "node:test";
import assert from "node:assert/strict";
import { suggestAutofill } from "../server/greenhouse-autofill.js";
import { validateProfileDraft } from "./fixtures/profile-draft.js";
import { isEmployeeConnectionQuestion } from "../server/autofill/employee-connections.js";

const profile = {
  discoverySource: { employeeReferral: false },
  employmentHistory: {
    currentOrFormerEmployee: false,
    knowsCurrentEmployees: false,
  },
};
const ask = (
  label: string,
  kind: "text" | "textarea" | "select" = "textarea",
  options: string[] = [],
  saved: any = profile,
) =>
  suggestAutofill(
    { id: "question_1", label, kind, required: true, options },
    saved,
    "Fabrikam",
  )?.value;

test("knowing or being related to people at the employer is always No", () => {
  for (const label of [
    "Do you know anyone who works at Fabrikam?",
    "Do you know anyone at Fabrikam?",
    "Do you know any current employees at Fabrikam?",
    "Do you have relatives that work at Wingtip?",
    "Are you related to anyone currently employed by Fabrikam?",
    "Do you have any friends or family who currently work for Fabrikam?",
    "Do you have any close personal relationships (e.g. family members, domestic partners, friends, etc.) currently employed at Northwind?",
    "Do you know anyone who works here? If so, please list their names.",
  ])
    assert.equal(ask(label), "No", label);
  assert.equal(
    ask("Do you know anyone who works at Fabrikam?", "select", [
      "Yes",
      "No, I don't know anyone",
    ]),
    "No, I don't know anyone",
  );
});

test("other relationship questions and unsaved facts stay unanswered", () => {
  for (const label of [
    "If yes, please include name(s) and the nature of the relationship(s).",
    "Please list any relatives who work at Fabrikam.",
    "Do you have relatives who work for a government agency or a Fabrikam customer?",
    "Are you related to any public officials?",
    "Were you referred by a current employee?",
  ])
    assert.equal(isEmployeeConnectionQuestion(label), false, label);
  assert.equal(
    ask("Do you know anyone who works at Fabrikam?", "textarea", [], {
      employmentHistory: { currentOrFormerEmployee: false },
    }),
    undefined,
  );
  assert.equal(
    ask("Do you know anyone who works at Fabrikam?", "select", [
      "No",
      "No, but I was referred",
    ]),
    undefined,
  );
});

test("an unmatched connection answer must cite the saved fact, not the referral", () => {
  const field = {
    label: "Do you know anyone currently employed at Fabrikam?",
    kind: "select" as const,
    options: ["Yes", "No"],
  };
  assert.equal(
    validateProfileDraft(field, profile, "No", [
      "employmentHistory.knowsCurrentEmployees",
    ]),
    "No",
  );
  assert.throws(
    () =>
      validateProfileDraft(field, profile, "No", [
        "discoverySource.employeeReferral",
      ]),
    /own confirmed/,
  );
});
