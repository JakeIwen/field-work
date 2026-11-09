import assert from "node:assert/strict";
import test from "node:test";
import {
  suggestAutofill,
  type Field,
} from "../server/suggest-autofill-rules.js";

const field = (
  id: string,
  label: string,
  kind: Field["kind"] = "select",
  options: string[] = ["Yes", "No"],
  conditional?: boolean,
): Field => ({
  id,
  label,
  kind,
  options,
  required: true,
  ...(conditional === undefined ? {} : { conditional }),
});

const profile = {
  firstName: "Sam",
  lastName: "Rivera",
  email: "sam@example.com",
  phone: "+12025550123",
  preferredFirstName: "Sammy",
  school: "Example Polytechnic - Main Campus",
  linkedIn: "https://www.linkedin.com/in/example",
  github: "https://github.com/example",
  website: "https://example.com",
  location: { city: "Seattle", state: "WA", country: "US" },
  authorizedToWorkUS: true,
  requiresSponsorshipNowOrFuture: false,
  resumeFacts: {
    education: {
      degree: "Bachelor's Degree",
      discipline: "Electrical Engineering",
      endYear: "2014",
    },
    experience: { minYears: 11.2, maxYears: 12 },
    highestDegreeRank: 3,
  },
  demographics: {
    gender: "Female",
    race: "Asian",
    hispanicLatino: true,
    veteran: false,
    disability: false,
    transgender: true,
    sexualOrientation: "Bisexual",
    activeMilitary: false,
  },
};

const answer = (
  value: string,
  label: string,
  options: string[] = ["Yes", "No"],
  id = "q",
  kind: Field["kind"] = "select",
  saved: Parameters<typeof suggestAutofill>[1] = profile,
  company = "Acme",
) => {
  const result = suggestAutofill(
    field(id, label, kind, options),
    saved,
    company,
  );
  if (result) assert.equal(result.value, value);
  return result;
};

test("suggestAutofill covers contact and school rules", () => {
  assert.deepEqual(answer("Sam", "First Name", [], "first_name", "text"), {
    value: "Sam",
  });
  assert.deepEqual(answer("Rivera", "Last Name", [], "last_name", "text"), {
    value: "Rivera",
  });
  assert.deepEqual(
    answer("sam@example.com", "Email Address", [], "email", "text"),
    {
      value: "sam@example.com",
    },
  );
  assert.deepEqual(
    answer("+12025550123", "Phone Number", [], "phone", "text"),
    {
      value: "+12025550123",
    },
  );
  assert.deepEqual(
    answer(
      "Sammy",
      "What is your preferred first name, if different from your legal first name?",
      [],
      "preferred",
      "text",
    ),
    { value: "Sammy" },
  );

  assert.deepEqual(answer(profile.school, "School", [], "school--0", "text"), {
    value: profile.school,
  });
  assert.deepEqual(
    answer(
      profile.school,
      "School Name",
      [],
      "school--0",
      "select",
      profile,
      "Acme",
    ),
    { value: profile.school, search: profile.school },
  );
  assert.deepEqual(
    answer(
      "Example Polytechnic – Main Campus",
      "University",
      ["Example Polytechnic – Main Campus"],
      "school--0",
    ),
    { value: "Example Polytechnic – Main Campus" },
  );
  assert.equal(
    answer(
      "Example Polytechnic – Main Campus",
      "University",
      [
        "Example Polytechnic – Main Campus",
        "Example Polytechnic – Main Campus",
      ],
      "school--0",
    ),
    null,
  );
  assert.equal(answer(profile.school, "School", [], "school--1", "text"), null);
});

test("suggestAutofill covers links, city, and state rules", () => {
  assert.deepEqual(
    answer(profile.linkedIn, "LinkedIn Profile URL", [], "q", "text"),
    {
      value: profile.linkedIn,
    },
  );
  assert.deepEqual(
    answer(profile.github, "GitHub Username / Profile", [], "q", "text"),
    {
      value: profile.github,
    },
  );
  assert.deepEqual(
    answer(profile.website, "Portfolio Website", [], "q", "text"),
    {
      value: profile.website,
    },
  );
  assert.deepEqual(answer("Seattle", "Current City", [], "q", "text"), {
    value: "Seattle",
  });
  assert.deepEqual(
    answer("WA - Washington", "State of Residence", ["WA - Washington"]),
    { value: "WA - Washington" },
  );
  assert.equal(
    answer(
      "WA - Washington",
      "State of Residence",
      ["WA - Washington"],
      "q",
      "select",
      { ...profile, location: { ...profile.location, state: "Unknown" } },
    ),
    null,
  );
  assert.equal(
    answer(
      "WA - Washington",
      "State of Residence",
      ["WA - Washington"],
      "q",
      "select",
      { ...profile, location: { ...profile.location, country: "CA" } },
    ),
    null,
  );
  assert.equal(
    answer("Yes", "Do you live in Washington ?", ["Yes", "No"]),
    null,
  );
});

test("suggestAutofill covers education, experience, degree fallback, and year rules", () => {
  assert.deepEqual(answer("Bachelor's Degree", "Degree", [], "degree--0"), {
    value: "Bachelor's Degree",
  });
  assert.deepEqual(answer("Engineering", "Discipline", [], "discipline--0"), {
    value: "Engineering",
    search: "Engineering",
  });
  assert.deepEqual(
    answer(
      "Electrical Engineering",
      "Discipline",
      ["Electrical Engineering", "Engineering"],
      "discipline--0",
    ),
    { value: "Electrical Engineering" },
  );
  assert.deepEqual(answer("2014", "End Date Year", [], "end-year--0", "text"), {
    value: "2014",
  });
  assert.deepEqual(
    answer(
      "10–15 years",
      "How many years of relevant professional experience do you have?",
      ["5–8 years", "8–10 years", "10–15 years", "15+ years"],
    ),
    { value: "10–15 years" },
  );
  assert.deepEqual(
    answer(
      "15+ years",
      "How many years of relevant professional experience do you have?",
      ["15+ years"],
      "q",
      "select",
      {
        ...profile,
        resumeFacts: {
          ...profile.resumeFacts,
          experience: { minYears: 15, maxYears: 18 },
        },
      },
    ),
    { value: "15+ years" },
  );
  assert.equal(
    answer(
      "10–15 years",
      "How many years of relevant professional experience do you have?",
      ["10–15 years", "10–15 years"],
    ),
    null,
  );
  assert.deepEqual(
    answer(
      "Yes",
      "Do you have a minimum of a bachelor's degree for your educational background?",
    ),
    { value: "Yes" },
  );
  assert.equal(answer("Yes", "Do you have at least a master's degree?"), null);
  assert.equal(
    answer(
      "Yes",
      "Do you have a minimum of a bachelor's degree in Computer Science?",
    ),
    null,
  );
});

test("suggestAutofill preserves US, state, and location guards", () => {
  assert.deepEqual(
    answer("Yes", "Do you currently live in the United States?"),
    { value: "Yes" },
  );
  assert.deepEqual(answer("Yes", "Are you a resident of Washington?"), {
    value: "Yes",
  });
  assert.deepEqual(answer("No", "Do you reside in California?"), {
    value: "No",
  });
  assert.equal(
    answer(
      "Yes",
      "Do you currently live in the United States?",
      ["Yes"],
      "q",
      "select",
      {
        ...profile,
        location: { city: "Seattle", state: "WA", country: undefined },
      },
    ),
    null,
  );
  assert.equal(answer("Yes", "Are you a resident of Atlantis?", ["Yes"]), null);
  assert.equal(
    answer("Yes", "Are you a resident of Washington?", ["Yes"], "q", "select", {
      ...profile,
      location: { city: "Seattle", state: undefined, country: "US" },
    }),
    null,
  );

  assert.deepEqual(answer("United States +1", "Country", [], "country"), {
    value: "United States +1",
  });
  assert.deepEqual(
    answer(
      "Seattle, Washington, United States",
      "Location (City)",
      [],
      "candidate-location",
    ),
    { value: "Seattle, Washington, United States", search: "Seattle" },
  );
  assert.deepEqual(
    answer(
      "Seattle, WA",
      "Where is your permanent (city, state) work location?",
      [],
      "q",
      "text",
    ),
    { value: "Seattle, WA" },
  );
});

test("suggestAutofill preserves company authorization and sponsorship guards", () => {
  assert.deepEqual(
    answer(
      "Yes",
      "Are you legally authorized to work in the United States of America for Acme?",
    ),
    { value: "Yes" },
  );
  assert.deepEqual(
    answer("No", "Will you now or in the future require visa sponsorship?"),
    { value: "No" },
  );
  const companyAlias =
    "No, I do not require sponsorship now or in the future to work legally for Acme in the United States.";
  assert.deepEqual(
    answer(
      companyAlias,
      "Will you now or in the future require Acme to sponsor or support an employment visa or work authorization in order to work in the United States?",
      [companyAlias],
    ),
    { value: companyAlias },
  );

  // The job's country is never verified: Sam's US facts answer either way.
  assert.deepEqual(
    answer(
      "Yes",
      "Are you authorized to lawfully work for Acme in the country to which you are applying?",
      ["Yes"],
    ),
    { value: "Yes" },
  );
  assert.deepEqual(
    answer(
      "No",
      "Do you now, or will you in the future, require employment visa sponsorship (e.g., H-1B visa, renewals, etc.) to work lawfully for Acme in the country that you are applying to?",
      ["No"],
    ),
    { value: "No" },
  );
});

test("suggestAutofill gives reusable answers precedence and preserves gender/race/Hispanic guards", () => {
  assert.deepEqual(
    answer("Asian background", "Race", ["Asian background"], "race"),
    { value: "Asian background" },
  );
  assert.deepEqual(answer("Female", "Gender", ["Female"], "gender"), {
    value: "Female",
  });
  assert.deepEqual(
    answer("Woman", "Which of the following best describes your gender?", [
      "Woman",
    ]),
    { value: "Woman" },
  );
  assert.deepEqual(answer("Yes", "Are you Hispanic/Latino?", ["Yes"]), {
    value: "Yes",
  });
  assert.equal(
    answer("Asian", "Race", ["Asian", "Asian"], "race", "select", {
      ...profile,
      demographics: { ...profile.demographics, hispanicLatino: true },
    }),
    null,
  );
});

test("suggestAutofill preserves disability and military guards", () => {
  assert.deepEqual(
    answer(
      "I am not a protected veteran",
      "Veteran Status",
      ["I am not a protected veteran"],
      "veteran_status",
    ),
    { value: "I am not a protected veteran" },
  );
  assert.deepEqual(
    answer("No, I am not a veteran", "Veteran Status:", [
      "No, I am not a veteran",
    ]),
    { value: "No, I am not a veteran" },
  );
  const longDisability =
    "Do you have a disability or chronic condition (physical, visual, auditory, cognitive, mental, emotional, or other) that substantially limits one or more of your major life activities, including mobility, communication (seeing, hearing, speaking), and learning?";
  assert.deepEqual(
    answer("Yes", longDisability, ["Yes"], "q", "select", {
      ...profile,
      demographics: { ...profile.demographics, disability: true },
    }),
    { value: "Yes" },
  );
  assert.deepEqual(
    answer(
      "Yes, I have a disability, or have had one in the past",
      "Disability Status",
      ["Yes, I have a disability, or have had one in the past"],
      "disability_status",
      "select",
      {
        ...profile,
        demographics: { ...profile.demographics, disability: true },
      },
    ),
    { value: "Yes, I have a disability, or have had one in the past" },
  );
  assert.deepEqual(
    answer(
      "Yes",
      "Do you identify as a person with a disability of any kind, visible or invisible?",
      ["Yes"],
      "q",
      "select",
      {
        ...profile,
        demographics: { ...profile.demographics, disability: true },
      },
    ),
    { value: "Yes" },
  );
  assert.deepEqual(answer("Yes", "Do you identify as transgender?", ["Yes"]), {
    value: "Yes",
  });
  assert.deepEqual(
    answer(
      "Bisexual",
      "How would you describe your sexual orientation? (mark all that apply)",
      ["Bisexual"],
    ),
    { value: "Bisexual" },
  );
  assert.deepEqual(
    answer(
      "No, I am not a veteran or active member",
      "Are you a veteran or active member of the United States Armed Forces?",
      ["No, I am not a veteran or active member"],
    ),
    { value: "No, I am not a veteran or active member" },
  );
  assert.equal(
    answer(
      "No, I am not a veteran or active member",
      "Are you a veteran or active member of the United States Armed Forces?",
      ["No, I am not a veteran or active member"],
      "q",
      "select",
      {
        ...profile,
        demographics: { ...profile.demographics, activeMilitary: true },
      },
    ),
    null,
  );
});

test("disability and veteran rules answer either saved direction without guessing unknown facts", () => {
  const cases = [
    {
      id: "disability_status",
      label: "Disability Status",
      key: "disability",
      options: [
        "Yes, I have a disability, or have had one in the past",
        "No, I do not have a disability",
      ],
    },
    {
      id: "question_1",
      label: "Veteran Status:",
      key: "veteran",
      options: ["Yes, I am a veteran", "No, I am not a veteran"],
    },
  ];
  for (const { id, label, key, options } of cases) {
    for (const value of [true, false]) {
      assert.deepEqual(
        suggestAutofill(
          field(id, label, "select", options),
          { demographics: { [key]: value } },
          "Example",
        ),
        { value: options[value ? 0 : 1] },
      );
    }
    assert.equal(
      suggestAutofill(field(id, label, "select", options), {}, "Example"),
      null,
    );
    assert.equal(
      suggestAutofill(
        field(id, label, "select", [...options, options[0]]),
        { demographics: { [key]: true } },
        "Example",
      ),
      null,
    );
  }
});

test("protected-veteran status is answered only for non-veterans", () => {
  const options = [
    "I identify as one or more of the classifications of protected veteran",
    "I am not a protected veteran",
  ];
  const ask = (veteran?: boolean) =>
    suggestAutofill(
      field("veteran_status", "Veteran Status", "select", options),
      veteran === undefined ? {} : { demographics: { veteran } },
      "Example",
    );
  assert.deepEqual(ask(false), { value: "I am not a protected veteran" });
  assert.equal(ask(true), null);
  assert.equal(ask(), null);
});

test("combined military status answers either direction and requires enough saved facts", () => {
  const military = field(
    "question_2",
    "Are you a veteran or active member of the United States Armed Forces?",
    "select",
    [
      "Yes, I am a veteran or active member",
      "No, I am not a veteran or active member",
    ],
  );
  for (const veteran of [true, false]) {
    for (const activeMilitary of [true, false]) {
      assert.deepEqual(
        suggestAutofill(
          military,
          { demographics: { veteran, activeMilitary } },
          "Example",
        ),
        { value: military.options[veteran || activeMilitary ? 0 : 1] },
      );
    }
  }
  for (const demographics of [
    {},
    { veteran: false },
    { activeMilitary: false },
  ])
    assert.equal(suggestAutofill(military, { demographics }, "Example"), null);
  for (const demographics of [{ veteran: true }, { activeMilitary: true }])
    assert.deepEqual(suggestAutofill(military, { demographics }, "Example"), {
      value: military.options[0],
    });
});

test("suggestAutofill leaves unsupported, unknown, incompatible, and duplicate answers blank", () => {
  assert.equal(
    answer("https://example.com", "Website", [
      "https://example.com",
      "https://example.com",
    ]),
    null,
  );
  assert.equal(answer("", "Website", ["Yes"]), null);
  assert.equal(answer("Yes", "Are you a US citizen?", ["Yes"]), null);
  assert.equal(
    answer(
      "Yes",
      "Will you now or in the future require visa sponsorship?",
      ["Yes"],
      "q",
      "select",
      {
        ...profile,
        requiresSponsorshipNowOrFuture: null,
      },
    ),
    null,
  );
});

test("overall experience wordings match ranges with or without a years suffix", () => {
  const ranges = ["0-1", "2-4", "5-9", "10-15", "15+"];
  for (const label of [
    "How many years of professional experience do you as a software engineer?",
    "How many years of experience do you have?",
    "How many years of software development experience do you have?",
    "How many years of professional experience do you have in software engineering?",
    "Years of Experience",
  ])
    assert.equal(
      suggestAutofill(field("q", label, "select", ranges), profile, "Example")
        ?.value,
      "10-15",
      label,
    );
  // One technology, or options with no range that holds the resume's years.
  for (const label of [
    "How many years of experience do you have with TypeScript?",
    "How many years of React experience do you have?",
  ])
    assert.equal(
      suggestAutofill(field("q", label, "select", ranges), profile, "Example"),
      null,
      label,
    );
  assert.equal(
    suggestAutofill(
      field(
        "q",
        "How many years of professional experience do you as a software engineer?",
        "select",
        ["0-1", "2-4", "5-8", "13-15", "15+"],
      ),
      profile,
      "Example",
    ),
    null,
  );
});

test("a list of states answers from the saved state", () => {
  const label =
    "Do you live in Alaska, California, DC, Delaware, Hawaii, Iowa, Maine, Maryland, Massachusetts, Montana, Nebraska, New Jersey, New Mexico, New York, North Dakota, South Dakota, Vermont, Washington, or West Virginia?";
  const choices = [
    "Alaska",
    "California",
    "DC",
    "Delaware",
    "Hawaii",
    "Iowa",
    "Maine",
    "Maryland",
    "Massachusetts",
    "Montana",
    "Nebraska",
    "New Jersey",
    "New Mexico",
    "New York",
    "North Dakota",
    "South Dakota",
    "Vermont",
    "Washington",
    "West Virginia",
    "No",
  ];
  const ask = (state: string, options = choices, text = label) =>
    suggestAutofill(
      field("q", text, "select", options),
      { ...profile, location: { city: "Somewhere", state, country: "US" } },
      "Example",
    )?.value;
  assert.equal(ask("CO"), "No");
  assert.equal(ask("TX"), "No");
  assert.equal(ask("NY"), "New York");
  assert.equal(ask("NY", ["Yes", "No"]), "Yes");
  assert.equal(
    ask("CO", ["Yes", "No"], "Do you live in New York or New Jersey?"),
    "No",
  );
  // A non-state or an ambiguous "Washington, DC" leaves it for review.
  for (const text of [
    "Do you live in New York, Ontario, or Quebec?",
    "Do you live in Maryland, Virginia, or Washington, DC?",
  ])
    assert.equal(ask("CO", ["Yes", "No"], text), undefined, text);
});
