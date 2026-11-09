import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { atomicWrite } from "../server/storage.js";
import {
  suggestAutofill,
  type Field,
} from "../server/suggest-autofill-rules.js";
import { readAutofillProfile } from "../server/autofill/profile.js";
import { generateAutofill } from "../server/greenhouse-autofill.js";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";

const education = {
  school: "Example University - Main Campus",
  degree: "Bachelor's Degree",
  discipline: "Engineering",
  startMonth: "August",
  startYear: "2004",
  endMonth: "May",
  endYear: "2009",
};
const fields: Field[] = [
  ["school", "School", "select"],
  ["degree", "Degree", "select"],
  ["discipline", "Discipline", "select"],
  ["start-month", "Start date month", "select"],
  ["start-year", "Start date year", "text"],
  ["end-month", "End date month", "select"],
  ["end-year", "End date year", "text"],
].map(([id, label, kind]) => ({
  id: `${id}--0`,
  label,
  kind: kind as Field["kind"],
  required: false,
  options: [],
}));

test("confirmed education fills all seven primary fields and bypasses answer drafting", async () => {
  const f = applicationAnswerFixture();
  try {
    atomicWrite(
      path.join(f.root, ".local/greenhouse/profile.json"),
      JSON.stringify({
        version: 1,
        firstName: "Test",
        email: "test@example.com",
        education,
      }),
    );
    f.form.html = f.form.html.replace(
      "</form>",
      fields
        .map(
          (field) =>
            `<label for="${field.id}">${field.label}</label><input id="${field.id}" ${field.kind === "select" ? 'role="combobox"' : 'type="number"'}>`,
        )
        .join("") + "</form>",
    );
    const plan = await generateAutofill(f.store, "one", f.read);
    for (const value of Object.values(education))
      assert.ok(plan.answers.some((a) => a.value === value));
    assert.equal(
      plan.dynamicQuestions?.some((q) => /--0$/.test(q.id)),
      false,
    );
    assert.equal(
      plan.review.some((q) => fields.some((field) => field.label === q.label)),
      false,
    );
    assert.deepEqual(readAutofillProfile(f.store).profile.education, education);
  } finally {
    f.cleanup();
  }
});

test("education dates stay scoped to the confirmed school and primary entry", () => {
  const field = fields[3];
  const profile = { school: education.school, education };
  assert.deepEqual(suggestAutofill(field, profile, "Example"), {
    value: "August",
  });
  for (const changed of [
    { ...field, id: "start-month--1" },
    { ...field, id: "question_123" },
    { ...field, label: "When can you start?" },
    { ...field, options: ["January", "February"] },
  ])
    assert.equal(suggestAutofill(changed, profile, "Example"), null);
  assert.equal(
    suggestAutofill(
      field,
      { ...profile, school: "Example University - Other Campus" },
      "Example",
    ),
    null,
  );
  assert.equal(
    suggestAutofill(field, { school: education.school }, "Example"),
    null,
  );
  assert.deepEqual(
    suggestAutofill(
      { ...field, options: ["July", "August", "September"] },
      profile,
      "Example",
    ),
    { value: "August" },
  );
});

test("confirmed values take precedence while missing dates remain unknown", () => {
  const profile = {
    school: education.school,
    education: {
      school: education.school,
      discipline: "Engineering",
      startMonth: null,
    },
    resumeFacts: {
      education: {
        degree: "Bachelor's Degree",
        discipline: "Electrical Engineering",
        endYear: "2009",
      },
    },
  };
  assert.equal(
    suggestAutofill(fields[2], profile, "Example")?.value,
    "Engineering",
  );
  assert.equal(
    suggestAutofill(fields[1], profile, "Example")?.value,
    "Bachelor's Degree",
  );
  assert.equal(suggestAutofill(fields[6], profile, "Example")?.value, "2009");
  for (const field of fields.slice(3, 6))
    assert.equal(suggestAutofill(field, profile, "Example"), null);
});

test("malformed confirmed education is rejected at the private profile boundary", () => {
  const f = applicationAnswerFixture();
  try {
    for (const invalid of [
      [],
      { ...education, school: "" },
      { ...education, startMonth: "Autumn" },
      { ...education, startYear: 2004 },
      { ...education, startYear: "2010" },
      { ...education, endYear: "2004", endMonth: "July" },
    ]) {
      atomicWrite(
        path.join(f.root, ".local/greenhouse/profile.json"),
        JSON.stringify({ version: 1, education: invalid }),
      );
      assert.throws(() => readAutofillProfile(f.store), /profile is invalid/);
    }
  } finally {
    f.cleanup();
  }
});
