import test from "node:test";
import assert from "node:assert/strict";
import { ageFromBirthDate } from "../server/autofill/profile-answers.js";
import {
  suggestAutofill,
  buildAutofillPlan,
} from "../server/greenhouse-autofill.js";
import {
  isSalaryQuestion,
  salaryExpectation,
} from "../server/autofill/salary.js";
import { narrativeQuestion } from "../server/application-answers.js";

const profile = {
  location: { country: "US" },
  authorizedToWorkUS: true,
  requiresSponsorshipNowOrFuture: false,
  englishProficiency: "native-or-bilingual",
  employmentHistory: { currentOrFormerEmployee: false },
  demographics: {
    gender: "Female",
    race: "Black",
    hispanicLatino: false,
    disability: false,
  },
  salaryExpectation: { strategy: "lowest-posted", fallbackAnnualUsd: 123000 },
};
const field = (label: string, options = ["Yes", "No"]) => ({
  id: "question_123",
  label,
  options,
  required: true,
  kind: "select" as const,
});
const answer = (
  label: string,
  options?: string[],
  saved: Parameters<typeof suggestAutofill>[1] = profile,
) => suggestAutofill(field(label, options), saved, "Example")?.value;

test("reusable answers tolerate wording and field-ID differences without changing the meaning", () => {
  for (const label of [
    "What is your current country of residence?",
    "Which country do you currently live in?",
    "Country of residence",
  ])
    assert.equal(
      answer(label, ["Canada", "United States of America"]),
      "United States of America",
    );
  for (const label of [
    "Are you currently eligible to work in the country where the job office is located?",
    "Are you legally permitted to work in the United States?",
    "Do you have the right to work in the country where this role is located?",
    "Are you authorized to work in Canada?",
    "Do you have the right to work in the EU?",
  ])
    assert.equal(answer(label), "Yes", label);
  for (const label of [
    "Do you now, or will you in the future, require employer-sponsored work authorization to legally work in the country where this role is located?",
    "Will you require employment visa sponsorship in the United States in the future?",
    "Do you need us to sponsor your work visa?",
    "(Skip this question if you are applying to work in Canada or the UK). Do you now or in the future require sponsorship?",
    "Will you require visa sponsorship to work in the United Kingdom?",
  ])
    assert.equal(answer(label), "No", label);
  for (const label of [
    "Are you a current or former Example, Subsidiary A, or Subsidiary B employee?",
    "Have you ever worked for Example?",
    "Were you previously employed by Example?",
  ])
    assert.equal(answer(label), "No");
  assert.equal(answer("Gender", ["Female", "Male", "Non-Binary"]), "Female");
  assert.equal(
    answer("Please select your gender identity", ["Woman", "Man"]),
    "Woman",
  );
  assert.equal(
    answer("Cultural Background", [
      "Black or African American",
      "Mixed or multiple backgrounds",
    ]),
    "Black or African American",
  );
  assert.equal(
    answer("Disability / Accessibility", [
      "I have a disability or long-term health condition that impacts my work or daily life",
      "I do not have a disability or long-term health condition",
    ]),
    "I do not have a disability or long-term health condition",
  );
  assert.equal(answer("Do you have a disability?"), "No");
});

test("inverse, sensitive, and compound declarations are not inferred from adjacent facts", () => {
  for (const label of [
    "What is your country of citizenship?",
    "What is your tax country of residence?",
    "Are you a US citizen?",
    "Are you authorized to work in the United States and Canada?",
    "Are you not eligible to work in the United States?",
    "Do you have relatives currently employed by Example?",
    "Have you ever applied to Example?",
    "Do you know a current or former Example employee?",
    "Have you never worked for Example?",
    "Have you ever worked remotely?",
    "Have you previously worked with React?",
    "Have you ever worked as a contractor for Example?",
    "Do you require a disability accommodation?",
    "What disability do you have?",
    "Do you have a diagnosed mental disability?",
    "What sex were you assigned at birth?",
  ])
    assert.equal(answer(label), undefined, label);
  assert.equal(
    answer("Cultural Background", ["Black British", "Black Irish"]),
    undefined,
  );
  assert.equal(
    answer("Gender", ["Female", "Woman"]),
    undefined,
    "ambiguous duplicate choices stay manual",
  );
  assert.equal(
    answer("Do you have a disability?", undefined, {
      ...profile,
      demographics: { ...profile.demographics, disability: null as any },
    }),
    undefined,
  );
  assert.equal(
    answer("Are you a current or former Example employee?", undefined, {
      ...profile,
      employmentHistory: {} as any,
    }),
    undefined,
  );
});

test("English level requires confirmation and matches equivalent proficiency options", () => {
  const q =
    "What level of English proficiency are you comfortable communicating in within a professional setting (both written and oral communications)?";
  const options = [
    "Elementary Proficiency (A1, A2)",
    "Intermediate Proficiency (B1, B2)",
    "Full Proficiency (C1, C2)",
    "Native or Bilingual in English",
  ];
  assert.equal(answer(q, options), "Native or Bilingual in English");
  assert.equal(answer("English proficiency", ["Basic", "Fluent"]), "Fluent");
  assert.equal(answer("Are you fluent in English?"), "Yes");
  assert.equal(
    answer(q, options, {
      ...profile,
      englishProficiency: undefined as any,
    }),
    undefined,
  );
  assert.equal(answer("Are you a native English speaker?"), undefined);
  assert.equal(
    narrativeQuestion({ ...field(q), kind: "text" }, "https://example.com"),
    null,
  );
});

test("age comes from confirmed DOB, respects birthdays, and chooses a unique bracket", () => {
  assert.equal(
    ageFromBirthDate("1991-07-10", new Date("2026-07-09T12:00:00Z")),
    34,
  );
  assert.equal(
    ageFromBirthDate("1991-07-10", new Date("2026-07-10T12:00:00Z")),
    35,
  );
  assert.equal(ageFromBirthDate("2025-02-30"), null);
  const saved = {
    ...profile,
    dateOfBirth: `${new Date().getUTCFullYear() - 40}-01-02`,
  };
  assert.equal(
    suggestAutofill(
      field("Age", ["Under 25", "25–34", "35–44", "45–54", "65 or older"]),
      saved,
      "Example",
    )?.value,
    "35–44",
  );
  assert.equal(answer("Age", ["35–44"]), undefined);
});

test("salary dropdown selects the bucket containing the published minimum in the right currency", () => {
  const f = {
    ...field(
      "What are your desired base salary expectations in your local currency?",
      [
        "USD $150,000 - $160,000",
        "USD $160,000 - $170,000",
        "MXN $150,000 - $160,000",
      ],
    ),
    inputType: "text",
  };
  const api = {
    content: "<p>Annual base salary: $154,000 - $204,000 USD.</p>",
  };
  assert.equal(isSalaryQuestion(f.label), true);
  assert.equal(isSalaryQuestion("What is your current salary?"), false);
  assert.equal(
    salaryExpectation(api, profile, f)?.value,
    "USD $150,000 - $160,000",
  );
  assert.ok(
    salaryExpectation(api, profile, {
      ...f,
      options: ["USD $150,000 - $160,000", "USD $150,000 - $170,000"],
    })?.reviewReason,
  );
  assert.ok(
    salaryExpectation(api, profile, {
      ...f,
      options: ["MXN $150,000 - $160,000"],
    })?.reviewReason,
  );
  assert.ok(
    salaryExpectation(
      {
        pay_input_ranges: [
          {
            min_cents: 5500,
            max_cents: 7500,
            currency_type: "USD",
            title: "Hourly pay",
          },
        ],
      },
      profile,
      { ...f, options: ["USD $50 - $60"] },
    )?.reviewReason,
  );
});

test("confirmed semantic mappings also work for radio and checkbox question groups", () => {
  const api = {
    company_name: "Example",
    location: { name: "United States" },
    questions: [
      { label: "First Name", fields: [{ name: "first_name" }] },
      { label: "Email", fields: [{ name: "email" }] },
      {
        label: "Are you a current or former Example employee?",
        required: true,
        fields: [
          { name: "employment", values: [{ label: "Yes" }, { label: "No" }] },
        ],
      },
      {
        label: "Consent to receive marketing",
        fields: [
          { name: "consent", values: [{ label: "Yes" }, { label: "No" }] },
        ],
      },
    ],
    demographic_questions: {
      questions: [
        {
          id: "gender",
          label: "Gender",
          answer_options: [{ label: "Female" }, { label: "Male" }],
        },
      ],
    },
  };
  const html =
    '<form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="email">Email</label><input id="email">' +
    [
      ["employment", "radio", "Yes", "No"],
      ["gender", "checkbox", "Female", "Male"],
      ["consent", "checkbox", "Yes", "No"],
    ]
      .map(([name, type, ...choices]) =>
        choices
          .map(
            (label, i) =>
              `<label for="${name}-${i}">${label}</label><input id="${name}-${i}" name="${name}" type="${type}" value="${i}">`,
          )
          .join(""),
      )
      .join("") +
    "</form>";
  const plan = buildAutofillPlan(
    "https://job-boards.greenhouse.io/example/jobs/1",
    html,
    api,
    { ...profile, firstName: "Test", email: "test@example.com" },
  );
  assert.equal(plan.fields.find((f) => f.id === "employment-1")?.value, "No");
  assert.equal(plan.fields.find((f) => f.id === "gender-0")?.value, "Female");
  assert.equal(
    plan.fields.some((f) => f.id.startsWith("consent")),
    false,
  );
});

test("select-all-that-apply race wording uses the single saved race", () => {
  const options = [
    "Alaska Native / American Indian / Indigenous/Aboriginal / Native American",
    "Black / African-American / Black-British / Caribbean",
    "Hispanic / Latinx",
    "Middle Eastern / North African",
    "Asian",
    "I don't wish to answer",
  ];
  for (const label of [
    "I identify my race / ethnicity as (select all that apply):",
    "I identify my racial or ethnic identity as:",
  ])
    assert.equal(
      answer(label, options),
      "Black / African-American / Black-British / Caribbean",
      label,
    );
  assert.equal(
    answer("I identify my gender as:", ["Woman", "Man", "Non-binary"]),
    "Woman",
  );
});

test("minimum-age questions answer from the saved birth date", () => {
  const born = { ...profile, dateOfBirth: "1988-04-17" };
  for (const label of [
    "Are you at least 18 years old?",
    "Are you 18 years of age or older?",
    "Are you over the age of 18?",
    "Are you at least 21 years of age?",
  ])
    assert.equal(answer(label, ["Yes", "No"], born), "Yes", label);
  assert.equal(answer("Are you at least 18 years old?"), undefined);
  const minor = { ...born, dateOfBirth: "2015-01-01" };
  assert.equal(
    answer("Are you at least 18 years old?", ["Yes", "No"], minor),
    "No",
  );
});

test("demographic synonyms cover different saved identities without inferring adjacent facts", () => {
  const cases = [
    ["Gender", "gender", "Male", "Man"],
    ["Gender", "gender", "Female", "Woman"],
    ["Gender", "gender", "Non-binary", "Nonbinary"],
    ["Gender", "gender", "Genderfluid", "Gender fluid"],
    ["Gender", "gender", "Genderqueer", "Gender queer"],
    ["Gender", "gender", "Decline to self-identify", "Prefer not to say"],
    ["Race", "race", "White", "White / European background"],
    ["Race", "race", "Black", "Black or African American"],
    ["Race", "race", "Asian", "Asian background"],
    ["Race", "race", "East Asian", "East Asian background"],
    ["Race", "race", "South Asian", "South Asian background"],
    [
      "Race",
      "race",
      "American Indian or Alaska Native",
      "American Indian / Alaska Native",
    ],
    [
      "Race",
      "race",
      "Native Hawaiian or Other Pacific Islander",
      "Native Hawaiian / Other Pacific Islander",
    ],
    ["Race", "race", "Hispanic or Latino", "Hispanic / Latinx"],
    [
      "Race",
      "race",
      "Middle Eastern or North African",
      "Middle Eastern / North African",
    ],
    ["Race", "race", "Two or more races", "Mixed or multiple backgrounds"],
    ["Race", "race", "Decline to self-identify", "Prefer not to say"],
    ["Sexual orientation", "sexualOrientation", "Straight", "Heterosexual"],
    ["Sexual orientation", "sexualOrientation", "Gay", "Homosexual"],
    [
      "Sexual orientation",
      "sexualOrientation",
      "Lesbian",
      "Lesbian / gay woman",
    ],
    ["Sexual orientation", "sexualOrientation", "Bisexual", "Bi"],
    ["Sexual orientation", "sexualOrientation", "Asexual", "Ace"],
    ["Sexual orientation", "sexualOrientation", "Pansexual", "Pan"],
    [
      "Sexual orientation",
      "sexualOrientation",
      "Decline to self-identify",
      "Prefer not to say",
    ],
    ["Pronouns", "pronouns", "He/Him/His", "He/Him"],
    ["Pronouns", "pronouns", "She/Her/Hers", "She/Her"],
    ["Pronouns", "pronouns", "They/Them/Theirs", "They/Them"],
    ["Pronouns", "pronouns", "Ze/Zir/Zirs", "Ze/Zir"],
    ["Pronouns", "pronouns", "Xe/Xem/Xyrs", "Xe/Xem"],
    ["Pronouns", "pronouns", "She/They", "She/Her/They/Them"],
    ["Pronouns", "pronouns", "He/They", "He/Him/They/Them"],
    ["Pronouns", "pronouns", "Decline to self-identify", "Prefer not to say"],
  ] as const;
  for (const [label, key, saved, option] of cases) {
    assert.equal(
      answer(label, [option, "Other"], {
        ...profile,
        demographics: { [key]: saved },
      }),
      option,
      `${label}: ${saved}`,
    );
    assert.equal(
      answer(label, [saved, option], {
        ...profile,
        demographics: { [key]: saved },
      }),
      undefined,
      "equivalent duplicate choices stay manual",
    );
  }
  assert.equal(
    answer("Do you have a disability?", ["Yes", "No"], {
      ...profile,
      demographics: { ...profile.demographics, disability: true },
    }),
    "Yes",
  );
  for (const value of [true, false]) {
    assert.equal(
      answer("Are you Hispanic/Latino?", ["Yes", "No"], {
        ...profile,
        demographics: { ...profile.demographics, hispanicLatino: value },
      }),
      value ? "Yes" : "No",
    );
  }
  assert.equal(
    answer("Race", ["White British", "White Irish"], {
      ...profile,
      demographics: { race: "White" },
    }),
    undefined,
    "broad race does not establish nationality",
  );
});
