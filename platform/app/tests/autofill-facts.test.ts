import test from "node:test";
import assert from "node:assert/strict";
import {
  educationFromResume,
  experienceFromResume,
} from "../server/autofill/resume-facts.js";
import { suggestAutofill } from "../server/greenhouse-autofill.js";
import {
  isSalaryQuestion,
  salaryExpectation,
} from "../server/autofill/salary.js";
import { narrativeQuestion } from "../server/application-answers.js";

const resume = `## EDUCATION
- **Web Development Certificate**, Example Academy, 2016
- **B.S. Electrical Engineering**, Example Polytechnic, Main Campus, 2014
`;
const facts = educationFromResume(
  resume,
  "Example Polytechnic - Main Campus",
  2026,
);
const profile = {
  location: { state: "WA", country: "US" },
  authorizedToWorkUS: true,
  requiresSponsorshipNowOrFuture: false,
  resumeFacts: facts,
  salaryExpectation: { strategy: "lowest-posted", fallbackAnnualUsd: 111000 },
};
const field = (
  id: string,
  label: string,
  kind: "select" | "text" = "select",
  options: string[] = ["Yes", "No"],
) => ({ id, label, kind, options, required: true });

test("explicit resume education supplies degree, discipline, year and minimum-degree eligibility", () => {
  assert.equal(facts.education?.degree, "Bachelor's Degree");
  assert.equal(facts.education?.discipline, "Electrical Engineering");
  assert.equal(facts.education?.endYear, "2014");
  assert.equal(
    suggestAutofill(
      field("degree--0", "Degree", "select", []),
      profile,
      "Tailspin",
    )?.value,
    "Bachelor's Degree",
  );
  assert.equal(
    suggestAutofill(
      field("discipline--0", "Discipline", "select", []),
      profile,
      "Tailspin",
    )?.value,
    "Engineering",
  );
  assert.equal(
    suggestAutofill(
      field("discipline--0", "Discipline", "select", [
        "Electrical Engineering",
        "Engineering",
      ]),
      profile,
      "Tailspin",
    )?.value,
    "Electrical Engineering",
  );
  assert.equal(
    suggestAutofill(
      field("end-year--0", "End date year", "text"),
      profile,
      "Tailspin",
    )?.value,
    "2014",
  );
  assert.equal(
    suggestAutofill(
      field(
        "q",
        "Do you have a minimum of an Associate’s Degree for your educational background?",
      ),
      profile,
      "Tailspin",
    )?.value,
    "Yes",
  );
  assert.equal(
    suggestAutofill(
      field("q", "Do you have at least a master’s degree?"),
      profile,
      "Tailspin",
    ),
    null,
  );
  assert.equal(
    suggestAutofill(
      field(
        "q",
        "Do you have a minimum of a bachelor’s degree in Computer Science?",
      ),
      profile,
      "Tailspin",
    ),
    null,
  );
  assert.equal(
    suggestAutofill(field("degree--1", "Degree"), profile, "Tailspin"),
    null,
  );
});
test("education parser rejects future, incomplete and mismatched-school assumptions", () => {
  assert.equal(
    educationFromResume(resume, "Example Polytechnic - North Campus", 2026)
      .education,
    null,
  );
  assert.equal(
    educationFromResume(resume.replace("2014", "2028"), profile, 2026)
      .highestDegreeRank,
    0,
  );
  assert.equal(
    educationFromResume(
      resume.replace(
        "Electrical Engineering",
        "Electrical Engineering (coursework)",
      ),
      "Example Polytechnic Main Campus",
      2026,
    ).highestDegreeRank,
    0,
  );
  assert.equal(
    educationFromResume(
      "## EDUCATION\n- **Certification**, Example Academy, 2016",
      "Academy",
      2026,
    ).highestDegreeRank,
    0,
  );
});
test("documented role dates select an unambiguous experience bucket without double-counting overlapping jobs", () => {
  const experience = experienceFromResume(
    "## PROFESSIONAL EXPERIENCE\n*June 2015 to Present*\n*May 2013 to June 2015*\n*October 2013 to June 2014*\n## EDUCATION\n*September 2010 to April 2014*",
    new Date("2026-09-26T12:00:00Z"),
  )!;
  assert.equal(experience.maxYears, 161 / 12);
  assert.ok(experience.minYears > 13);
  const question = field(
    "q",
    "How many years of relevant professional experience do you have?",
    "select",
    ["5–8 years", "8–10 years", "10–15 years", "15+ years"],
  );
  assert.equal(
    suggestAutofill(
      question,
      { ...profile, resumeFacts: { ...facts, experience } },
      "Contoso",
    )?.value,
    "10–15 years",
  );
  assert.equal(
    suggestAutofill(
      { ...question, label: "How many years of React experience do you have?" },
      { ...profile, resumeFacts: { ...facts, experience } },
      "Contoso",
    ),
    null,
  );
  assert.equal(
    experienceFromResume(
      "## PROFESSIONAL EXPERIENCE\n6+ years",
      new Date("2026-09-26"),
    ),
    null,
  );
});
test("declared state and equivalent US authorization wording reuse facts without inferring citizenship", () => {
  const contact = {
    ...profile,
    preferredFirstName: "Preferred",
    location: { ...profile.location, city: "Test City" },
  };
  assert.equal(
    suggestAutofill(
      field(
        "question_123",
        "What is your preferred first name, if different from your legal first name?",
        "text",
      ),
      contact,
      "Example",
    )?.value,
    "Preferred",
  );
  assert.equal(
    suggestAutofill(
      field("question_124", "What city do you live in?", "text"),
      contact,
      "Example",
    )?.value,
    "Test City",
  );
  assert.equal(
    suggestAutofill(
      field("q", "What state do you live in?", "select", [
        "CA - California",
        "WA - Washington",
      ]),
      contact,
      "Example",
    )?.value,
    "WA - Washington",
  );
  assert.equal(
    suggestAutofill(
      field(
        "q",
        "Will you now or in the future require employer sponsorship to obtain or maintain authorization to work in the United States?",
      ),
      contact,
      "Example",
    )?.value,
    "No",
  );
  assert.equal(
    suggestAutofill(
      field("q", "Github Username / Profile", "text"),
      { ...contact, github: "https://github.com/example" },
      "Example",
    )?.value,
    "https://github.com/example",
  );
  assert.equal(
    narrativeQuestion(
      {
        ...field(
          "question_123",
          "What is your preferred first name, if different from your legal first name?",
          "text",
        ),
      },
      "https://example.com",
    ),
    null,
  );
  assert.equal(
    narrativeQuestion(
      { ...field("question_124", "What city do you live in?", "text") },
      "https://example.com",
    ),
    null,
  );
  assert.equal(
    suggestAutofill(
      field("q", "Do you reside in California?"),
      profile,
      "Tailspin",
    )?.value,
    "No",
  );
  assert.equal(
    suggestAutofill(
      field("q", "Are you a resident of Washington?"),
      profile,
      "Tailspin",
    )?.value,
    "Yes",
  );
  assert.equal(
    suggestAutofill(
      field("q", "Do you currently live in the United States?"),
      profile,
      "Tailspin",
    )?.value,
    "Yes",
  );
  assert.equal(
    suggestAutofill(
      field(
        "q",
        "Are you legally authorized to work in the United States of America?",
      ),
      profile,
      "Tailspin",
    )?.value,
    "Yes",
  );
  assert.equal(
    suggestAutofill(
      field(
        "q",
        "Will you now or in the future require immigration sponsorship for employment visa status?",
      ),
      profile,
      "Tailspin",
    )?.value,
    "No",
  );
  assert.equal(
    suggestAutofill(field("q", "Are you a US citizen?"), profile, "Tailspin"),
    null,
  );
  const local = field(
    "q",
    "Are you authorized to lawfully work for Contoso in the country to which you are applying?",
  );
  assert.equal(suggestAutofill(local, profile, "Contoso")?.value, "Yes");
});
test("discovery source is not sent to Codex to invent from resume evidence", () => {
  assert.equal(
    narrativeQuestion(
      {
        ...field("question_123", "How did you hear about this role?", "text"),
        maxLength: 1000,
      },
      "https://example.com",
    ),
    null,
  );
});
test("salary preference chooses the lowest current range or the explicit fallback", () => {
  const salaryField = { label: "What are your base salary expectations?" };
  assert.equal(isSalaryQuestion(salaryField.label), true);
  assert.equal(
    salaryExpectation(
      {
        pay_input_ranges: [
          { min_cents: 18000000, max_cents: 20000000, currency_type: "USD" },
          { min_cents: 20000000, max_cents: 24000000, currency_type: "USD" },
        ],
      },
      profile,
      salaryField,
    )?.value,
    "$180,000",
  );
  assert.equal(
    salaryExpectation(
      { content: "<p>Salary is not published.</p>" },
      profile,
      salaryField,
    )?.value,
    "$111,000",
  );
  assert.equal(
    salaryExpectation(
      {
        content:
          "<p>Base salary: $140,000–$160,000 per year.</p><p>Office stipend: $1,000.</p>",
      },
      profile,
      salaryField,
    )?.value,
    "$140,000",
  );
  assert.equal(
    salaryExpectation({}, profile, { ...salaryField, inputType: "number" })
      ?.value,
    "111000",
  );
  assert.equal(salaryExpectation({}, {}, salaryField), null);
});
test("salary handling preserves hourly units and never compares different currencies", () => {
  const api = {
    pay_input_ranges: [
      {
        min_cents: 5500,
        max_cents: 7500,
        currency_type: "USD",
        title: "Hourly pay",
      },
    ],
  };
  assert.equal(
    salaryExpectation(api, profile, { label: "Salary expectations" })?.value,
    "$55 per hour",
  );
  assert.ok(
    salaryExpectation(api, profile, { label: "Annual salary expectations" })
      ?.reviewReason,
  );
  assert.ok(
    salaryExpectation(
      {
        pay_input_ranges: [
          { min_cents: 10000000, max_cents: 15000000, currency_type: "USD" },
          { min_cents: 9000000, max_cents: 12000000, currency_type: "EUR" },
        ],
      },
      profile,
      { label: "Salary expectations" },
    )?.reviewReason,
  );
});
