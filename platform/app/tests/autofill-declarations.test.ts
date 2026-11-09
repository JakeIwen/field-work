import test from "node:test";
import assert from "node:assert/strict";
import { directAutofillRule } from "../server/autofill/plan-rules.js";

const profile = {
  location: { city: "Springfield", state: "WA", country: "US" },
  salaryExpectation: {
    strategy: "lowest-posted",
    fallbackAnnualUsd: 111000,
    rangeTopAnnualUsd: 222000,
  },
  preferences: { privacyNotices: true, backgroundCheck: true },
  employmentHistory: { boundByRestrictiveAgreement: false },
};
const noPay = { content: "", compensation: undefined } as any;
const ask = (
  label: string,
  options = ["Yes", "No"],
  description?: string,
  saved: any = profile,
  posting: any = noPay,
  kind: "text" | "select" = "select",
) =>
  directAutofillRule(
    {
      id: "question_1",
      label,
      kind,
      required: true,
      options,
      ...(description ? { description } : {}),
    },
    posting,
    saved,
    "Example",
  );

test("applicant privacy notices are acknowledged with the form's own choice", () => {
  assert.equal(
    ask(
      "Applicant Privacy Notice",
      ["I acknowledge receipt of the Applicant Privacy Notice."],
      "Before you submit your application, please read and acknowledge receipt of the Applicant Privacy Notice.",
    ).answer?.value,
    "I acknowledge receipt of the Applicant Privacy Notice.",
  );
  assert.equal(
    ask(
      'By clicking "I acknowledge," you agree to our Privacy Policy and data processing. Providing accurate information is essential, as any dishonesty may lead to rejection of an application or termination.',
      ["I acknowledge"],
    ).answer?.value,
    "I acknowledge",
  );
  for (const [label, options, description] of [
    [
      'By clicking "Submit Application" I agree to the Applicant Privacy Policy & Terms of Service',
      ["I agree"],
    ],
    [
      "I certify that the information provided is true and complete, and I acknowledge the Privacy Notice.",
      ["I acknowledge"],
    ],
    [
      "Do you agree to allow Example to retain your data and contact you about future opportunities? Recruiting Privacy Policy",
      ["Yes", "No"],
    ],
    [
      "Are you at least 18 years of age?",
      ["Yes", "No"],
      "We process your answers as described in our Applicant Privacy Notice, which you acknowledge.",
    ],
  ] as const)
    assert.equal(
      ask(label, [...options], description).answer?.value,
      undefined,
      label,
    );
  assert.equal(
    ask("Applicant Privacy Notice", ["I do not acknowledge", "I acknowledge"])
      .answer?.value,
    "I acknowledge",
  );
  assert.equal(
    ask("Applicant Privacy Notice", ["I acknowledge"], undefined, {
      ...profile,
      preferences: {},
    }).answer,
    null,
  );
});

test("background-check willingness is Yes; record questions stay manual", () => {
  assert.equal(
    ask(
      "If extended an offer of employment, would you be willing to consent to a background check conducted in accordance with applicable law?",
      ["Yes", "No"],
      "Submitting to a criminal background check is a condition of employment, only once an offer has been made. Conviction of a crime is not an automatic bar from employment.",
    ).answer?.value,
    "Yes",
  );
  assert.equal(
    ask("Are you willing to undergo a background check?").answer?.value,
    "Yes",
  );
  for (const label of [
    "Are you willing to undergo a background check and drug screening?",
    "Would you be able to pass a background check?",
    "I authorize Example to conduct a background check.",
    "Have you ever been convicted of a felony?",
  ])
    assert.equal(ask(label).answer, null, label);
});

test("restrictive-agreement questions are No; confidentiality stays manual", () => {
  assert.equal(
    ask(
      "Are you subject to an agreement with a former employer or other party (such as non-competition or non-solicitation agreement) that might, in any way, restrict your ability to work for our Company?",
    ).answer?.value,
    "No",
  );
  assert.equal(
    ask("Are you currently bound by a non-compete agreement?", [
      "Yes",
      "No, I am not",
    ]).answer?.value,
    "No, I am not",
  );
  for (const label of [
    "Are you subject to any non-compete, non-solicitation or confidentiality agreements?",
    "Have you ever signed a non-compete agreement?",
    "Would you be willing to sign a non-compete agreement?",
  ])
    assert.equal(ask(label).answer, null, label);
});

test("the upper end of a desired salary range uses the saved top", () => {
  const label =
    "What is the end of your desired annual base salary range? (please format with no commas, i.e. $70000, £70000)";
  assert.equal(
    ask(label, [], undefined, profile, noPay, "text").answer?.value,
    "$222000",
  );
  assert.equal(
    ask("Maximum desired salary", [], undefined, profile, noPay, "text").answer
      ?.value,
    "$222,000",
  );
  const highPay = {
    content: "",
    compensation: {
      publishedText: "$260,000 - $320,000",
      interpretable: true,
      ranges: [
        {
          min: 260000,
          max: 320000,
          currency: "USD",
          period: "year",
          basis: "base",
          publishedText: "$260,000 - $320,000",
        },
      ],
    },
  };
  const high = ask(label, [], undefined, profile, highPay, "text");
  assert.equal(high.answer, null);
  assert.match(high.salary?.reviewReason ?? "", /at or above/);
  assert.equal(
    ask(
      "What is the end of your desired hourly pay range?",
      [],
      undefined,
      profile,
      noPay,
      "text",
    ).answer,
    null,
  );
});
