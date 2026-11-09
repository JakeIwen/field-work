import test from "node:test";
import assert from "node:assert/strict";
import {
  isUSOnlyPosting,
  referralNameNotApplicable,
} from "../server/autofill/profile-answers.js";
import {
  suggestAutofill,
  buildAutofillPlan,
} from "../server/greenhouse-autofill.js";

const profile = {
  firstName: "Test",
  email: "test@example.com",
  requiresSponsorshipNowOrFuture: false,
  discoverySource: {
    strategy: "hosting-service-search",
    employeeReferral: false,
  },
  employmentHistory: {
    currentOrFormerEmployee: false,
    edTechExperience: true,
    edTechEmployers: [],
  },
  demographics: {
    gender: "Non-binary",
    race: "Asian",
    sexualOrientation: "Bisexual",
    pronouns: "They/Them/Theirs",
    transgender: true,
    veteran: true,
    activeMilitary: false,
  },
};
const field = (label: string, options = ["Yes", "No"]) => ({
  id: "question_123",
  label,
  kind: "select" as const,
  required: true,
  options,
});
const answer = (label: string, options?: string[], saved: any = profile) =>
  suggestAutofill(field(label, options), saved, "Example")?.value;

test("US-only posting context recognizes common remote spellings without flattening multiple countries", () => {
  for (const location of [
    "Remote - US",
    "US - Remote",
    "Remote, U.S.",
    "USA",
    "United States (Remote)",
    "Any location - United States",
  ])
    assert.equal(isUSOnlyPosting(location), true, location);
  for (const location of [
    "US / Canada",
    "Remote - Canada",
    "United States and UK",
    "Worldwide",
    "Remote",
    "San Francisco",
    undefined,
  ])
    assert.equal(isUSOnlyPosting(location), false, String(location));
  const label =
    "Will you now or in the future require immigration sponsorship (e.g. H-1B sponsorship)?";
  assert.equal(answer(label), "No");
  assert.equal(answer(label, undefined, {}), undefined);
  assert.equal(
    answer("Will you require immigration sponsorship in Canada?"),
    "No",
  );
  assert.equal(
    answer("Will you not require immigration sponsorship?"),
    undefined,
  );
});

test("plain and multi-select demographic questions reuse confirmed values without inferring other identities", () => {
  for (const ending of [
    "?",
    " (mark all that apply)",
    " (select all that apply)",
  ]) {
    assert.equal(
      answer("How would you describe your gender identity" + ending, [
        "Non-binary",
        "Woman",
      ]),
      "Non-binary",
    );
    assert.equal(
      answer("How would you describe your racial/ethnic background" + ending, [
        "Asian background",
        "East Asian",
      ]),
      "Asian background",
    );
    assert.equal(
      answer("How would you describe your sexual orientation" + ending, [
        "Bisexual",
        "Gay",
      ]),
      "Bisexual",
    );
  }
  assert.equal(
    answer("What are your pronouns?", ["They/Them", "She/Her", "Ze/Zir"]),
    "They/Them",
  );
  assert.equal(
    answer("What are your pronouns?", ["They/Them"], {
      demographics: { gender: "Non-binary" },
    }),
    undefined,
  );
  assert.equal(answer("Do you identify as transgender?"), "Yes");
  assert.equal(
    answer("Do you identify as transgender?", undefined, {
      demographics: {
        gender: "Non-binary",
        sexualOrientation: "Bisexual",
        pronouns: "They/Them/Theirs",
      },
    }),
    undefined,
  );
  const military =
    "Are you a veteran or active member of the United States Armed Forces?";
  assert.equal(
    answer(
      military,
      [
        "Yes, I am a veteran or active member",
        "No, I am not a veteran or active member",
      ],
      { demographics: { veteran: false, activeMilitary: false } },
    ),
    "No, I am not a veteran or active member",
  );
  assert.equal(
    answer(military, ["No, I am not a veteran or active member"], {
      demographics: { veteran: true },
    }),
    undefined,
  );
});

test("employee-referral answers need the explicit preference and optional referrer names can be not applicable", () => {
  for (const label of [
    "Were you referred by a current employee of the company?",
    "Are you referred by an employee of Example?",
    "Did you receive an employee referral?",
  ])
    assert.equal(answer(label), "No");
  assert.equal(
    answer(
      "Were you referred by a current employee of the company?",
      undefined,
      { discoverySource: { strategy: "hosting-service-search" } },
    ),
    undefined,
  );
  assert.equal(
    answer("Do you know a current employee of the company?"),
    undefined,
  );
  assert.equal(
    referralNameNotApplicable(
      "If you were referred by a current employee, what is the employee's full name?",
      profile,
    ),
    true,
  );
  assert.equal(
    referralNameNotApplicable(
      "If you were referred by a current employee, what is the employee's full name?",
      {},
    ),
    false,
  );
  assert.equal(
    referralNameNotApplicable("What is your full name?", profile),
    false,
  );
});

test("industry-specific questions remain available for model interpretation rather than employer-specific rules", () => {
  const experience = "Have you previously worked in e-learning or ed-tech?";
  const employer =
    "If you previously worked at another ed-tech company, please select your employer from the list below:";
  assert.equal(answer(experience), undefined);
  assert.equal(
    answer(employer, ["Example Learning", "Other", "N/A"]),
    undefined,
  );
  assert.equal(
    answer(experience, undefined, {
      employmentHistory: { currentOrFormerEmployee: false },
    }),
    undefined,
  );
  assert.equal(
    answer(employer, ["Other", "N/A"], {
      employmentHistory: { edTechExperience: true },
    }),
    undefined,
  );
  assert.equal(
    answer("Have you previously worked in ed-tech and fintech?"),
    undefined,
  );
  assert.equal(
    answer("Have you built a learning management system?"),
    undefined,
  );
});

test("plan suppresses only an optional inapplicable referrer name and keeps required discrepancies visible", () => {
  const referrer =
    "If you were referred by a current employee, what is the employee's full name?";
  const questions = [
    { label: "First Name", required: true, fields: [{ name: "first_name" }] },
    { label: "Email", required: true, fields: [{ name: "email" }] },
    {
      label: "Were you referred by a current employee of the company?",
      required: true,
      fields: [
        { name: "question_1", values: [{ label: "Yes" }, { label: "No" }] },
      ],
    },
    { label: referrer, required: false, fields: [{ name: "question_2" }] },
    {
      label:
        "Will you now or in the future require immigration sponsorship (e.g. H-1B sponsorship)?",
      required: true,
      fields: [
        { name: "question_3", values: [{ label: "Yes" }, { label: "No" }] },
      ],
    },
  ];
  const html =
    '<form id="application-form">' +
    questions
      .map(
        (q) =>
          `<label for="${q.fields[0].name}">${q.label}</label><input id="${q.fields[0].name}" ${"values" in q.fields[0] ? 'role="combobox"' : ""}>`,
      )
      .join("") +
    "</form>";
  const api = {
    company_name: "Example",
    location: { name: "Remote - US" },
    questions,
  };
  const plan = buildAutofillPlan(
    "https://job-boards.greenhouse.io/example/jobs/1",
    html,
    api,
    profile,
  );
  assert.equal(plan.review.length, 0);
  assert.equal(
    plan.fields.some((f) => f.id === "question_2"),
    false,
    "leave inapplicable name blank",
  );
  assert.equal(plan.fields.find((f) => f.id === "question_3")?.value, "No");
  questions[3].required = true;
  assert.equal(
    buildAutofillPlan(plan.url, html, api, profile).review.some(
      (q) => q.label === referrer,
    ),
    true,
  );
});

test("race aliases and non-Hispanic variants work for several saved groups without cultural background overriding race", () => {
  const groups = [
    ["Asian", "Asian background"],
    ["Black", "Black or African American"],
    ["American Indian or Alaska Native", "American Indian / Alaska Native"],
    [
      "Native Hawaiian or Other Pacific Islander",
      "Native Hawaiian / Other Pacific Islander",
    ],
    ["Middle Eastern or North African", "Middle Eastern / North African"],
  ];
  for (const [race, alias] of groups) {
    for (const suffix of ["", " (Not Hispanic or Latino)", " (non-Hispanic)"]) {
      const selected = alias + suffix;
      const field = {
        id: "race",
        label: "Race",
        kind: "select" as const,
        required: false,
        options: [selected, "Prefer not to answer"],
      };
      for (const demographics of [
        {
          race,
          culturalBackground: "Two or more races",
          hispanicLatino: false,
        },
        { culturalBackground: race, hispanicLatino: false },
      ])
        assert.deepEqual(suggestAutofill(field, { demographics }, "Example"), {
          value: selected,
        });
      if (suffix) {
        for (const hispanicLatino of [true, undefined])
          assert.equal(
            suggestAutofill(
              field,
              { demographics: { race, hispanicLatino } },
              "Example",
            ),
            null,
          );
      }
    }
  }
  const legacyBackground = "Black or African American";
  const field = {
    id: "race",
    label: "Race",
    kind: "select" as const,
    required: false,
    options: ["Asian", legacyBackground],
  };
  assert.deepEqual(
    suggestAutofill(
      field,
      { demographics: { race: "Asian", culturalBackground: legacyBackground } },
      "Example",
    ),
    { value: "Asian" },
  );
});
