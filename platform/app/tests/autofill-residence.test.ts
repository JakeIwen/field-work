import test from "node:test";
import assert from "node:assert/strict";
import { suggestAutofill } from "../server/greenhouse-autofill.js";
import { validateProfileDraft } from "./fixtures/profile-draft.js";

const profile = {
  location: {
    city: "Springfield",
    state: "WA",
    country: "US",
    postalCode: "98000-0000",
    streetAddress: "100 Example Ave Suite 1",
  },
  applicationLocation: { country: "US", residesInUSFullTime: true },
};
const ask = (
  label: string,
  kind: "text" | "textarea" | "select" = "text",
  options: string[] = [],
  saved: any = profile,
  maxLength?: number,
) =>
  suggestAutofill(
    {
      id: "question_1",
      label,
      kind,
      required: true,
      options,
      ...(maxLength ? { maxLength } : {}),
    },
    saved,
    "Example",
  )?.value;

test("ZIP and address questions use the saved mailing address", () => {
  for (const label of ["Zipcode", "Zip Code of Residence:", "ZIP/Postal Code"])
    assert.equal(ask(label), "98000-0000", label);
  assert.equal(ask("Zip code", "text", [], profile, 5), "98000");
  const full = "100 Example Ave Suite 1, Springfield, WA 98000-0000";
  assert.equal(ask("Legal Address", "textarea"), full);
  assert.equal(ask("Home address"), full);
  assert.equal(ask("What is your mailing address?"), full);
  assert.equal(ask("Street Address"), "100 Example Ave Suite 1");
  assert.equal(ask("Address Line 1"), "100 Example Ave Suite 1");
  for (const label of ["Email address", "Address Line 2", "Work address"])
    assert.notEqual(ask(label), full, label);
});

test("an incomplete saved address answers nothing", () => {
  const cityOnly = {
    location: {
      city: "Springfield",
      state: "WA",
      country: "US",
      postalCode: null,
    },
  };
  assert.equal(ask("Zipcode", "text", [], cityOnly), undefined);
  assert.equal(ask("Legal Address", "textarea", [], cityOnly), undefined);
});

test("full-time US residence follows the saved commitment", () => {
  for (const label of [
    "Will you reside in the United States full time?",
    "Do you live in the U.S. full-time?",
    "Are you a full-time resident of the United States?",
    "Will you be residing in the US full time while employed with Example?",
  ])
    assert.equal(ask(label, "select", ["Yes", "No"]), "Yes", label);
  assert.equal(
    ask(
      "Will you reside in the United States full time?",
      "select",
      ["Yes", "No"],
      {
        ...profile,
        applicationLocation: { country: "US" },
      },
    ),
    undefined,
  );
});

test("a drafted address answer must cite the saved street address", () => {
  const field = { label: "Legal Address", kind: "textarea" as const };
  const address = "100 Example Ave Suite 1, Springfield, WA 98000-0000";
  assert.equal(
    validateProfileDraft(field, profile, address, ["location.streetAddress"]),
    address,
  );
  assert.throws(
    () => validateProfileDraft(field, profile, address, ["location.city"]),
    /own confirmed/,
  );
});
