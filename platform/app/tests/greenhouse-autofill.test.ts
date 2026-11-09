import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { unzipSync } from "fflate";
import { Script } from "node:vm";
import { Store, atomicWrite } from "../server/storage.js";
import {
  greenhousePosting,
  autofillActivity,
} from "../shared/greenhouse-autofill.js";
import {
  buildAutofillPlan,
  generateAutofill,
  savedAutofills,
  savedAutofillScript,
  suggestAutofill,
} from "../server/greenhouse-autofill.js";
import type { CareersFetch } from "../server/careers/http.js";

const url = "https://job-boards.greenhouse.io/example/jobs/123";
// Synthetic applicant profile. No network required.
const profile = {
  version: 1,
  firstName: "Test",
  lastName: "Applicant",
  email: "test@example.com",
  phone: "5555550100",
  location: { city: "Seattle", state: "WA", country: "US" },
  authorizedToWorkUS: true,
  requiresSponsorshipNowOrFuture: false,
  demographics: {
    gender: "Non-binary",
    race: "Decline to self-identify",
    veteran: true,
    disability: false,
    hispanicLatino: null,
  },
};
const question = (
  name: string,
  label: string,
  values: string[] = [],
  required = false,
) => ({
  label,
  required,
  fields: [
    {
      name,
      type: values.length ? "multi_value_single_select" : "input_text",
      values: values.map((label, value) => ({ label, value })),
    },
  ],
});
const api = {
  id: 123,
  title: "Engineer",
  company_name: "Example",
  questions: [
    question("first_name", "First Name", [], true),
    question("email", "Email", [], true),
    question("phone", "Phone"),
    question(
      "question_auth",
      "Are you legally authorized to work in the United States?",
      ["Yes", "No"],
      true,
    ),
    question(
      "question_sponsor",
      "Will you now or in the future require visa sponsorship?",
      ["Yes", "No"],
      true,
    ),
    question(
      "question_unknown",
      "Are you willing to work weekends?",
      ["Yes", "No"],
      true,
    ),
    {
      label: "Resume/CV",
      required: true,
      fields: [{ name: "resume", type: "input_file", values: [] }],
    },
  ],
  demographic_questions: {
    questions: [
      {
        id: 1234,
        label:
          "How would you describe your racial/ethnic background? (mark all that apply)",
        answer_options: [
          { label: "Decline to self-identify", free_form: false },
        ],
      },
    ],
  },
};
const input = (id: string, label: string, attrs = "") =>
  `<label for="${id}">${label}</label><input id="${id}" ${attrs}>`;
const html = `<form id="application-form">${input("first_name", "First Name*")}${input("email", "Email*")}${input("phone", "Phone")}
${input("country", "Country*", 'role="combobox" aria-required="true"')}${input("candidate-location", "Location (City)*", 'role="combobox"')}
${input("question_auth", api.questions[3].label, 'role="combobox"')}${input("question_sponsor", api.questions[4].label, 'role="combobox"')}
${input("question_unknown", api.questions[5].label, 'role="combobox"')}${input("1234", api.demographic_questions.questions[0].label, 'role="combobox"')}
${input("hispanic_ethnicity", "Are you Hispanic/Latino?", 'role="combobox"')}${input("resume", "Attach", 'type="file"')}
<button type="submit">Submit</button></form>`;
const reader: CareersFetch = async (requested) => ({
  url: requested,
  requestedUrl: requested,
  status: 200,
  type: requested.includes("boards-api") ? "application/json" : "text/html",
  text: requested.includes("boards-api") ? JSON.stringify(api) : html,
  at: new Date().toISOString(),
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "greenhouse-autofill-"));
  const store = new Store(root, path.join(root, ".local/data"));
  for (const p of [
    "AGENTS.md",
    "source_data/README.md",
    "source_data/resume.md",
    "source_data/github_evidence_dossier.md",
  ])
    atomicWrite(path.join(root, p), "Synthetic test evidence.");
  const profileFile = path.join(root, ".local/greenhouse/profile.json");
  atomicWrite(profileFile, JSON.stringify(profile));
  store.put(
    "cache_opening",
    "one" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
    {
      id: "one",
      url,
      hash: "opening-source",
      title: "Engineer",
    } as Records["cache_opening"],
  );
  return {
    store,
    profileFile,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("Greenhouse URLs preserve identity across hosted and direct forms and reject ambiguous tokens", () => {
  assert.equal(
    greenhousePosting(
      "https://boards.greenhouse.io/example/jobs/123?gh_src=abc",
    )?.url,
    url,
  );
  assert.equal(
    greenhousePosting(
      "https://job-boards.greenhouse.io/embed/job_app?token=123&for=example&gh_src=test",
    )?.url,
    url,
  );
  assert.equal(
    greenhousePosting(
      "https://job-boards.greenhouse.io/embed/job_app?token=123&for=example",
    )?.applicationUrl,
    "https://job-boards.greenhouse.io/embed/job_app?for=example&token=123",
  );
  for (const invalid of [
    "https://job-boards.greenhouse.io/embed/job_app?for=example&token=123&token=999",
    "https://job-boards.greenhouse.io/embed/job_app?for=example&for=other&token=123",
    "https://job-boards.greenhouse.io/embed/job_app?for=example",
    "https://job-boards.greenhouse.io/embed/job_app?for=../other&token=123",
  ])
    assert.equal(greenhousePosting(invalid), null);
  for (const invalid of [
    "https://greenhouse.io.evil.test/example/jobs/123",
    "https://user:pass@job-boards.greenhouse.io/example/jobs/123",
    "https://job-boards.greenhouse.io/example",
    "https://example.com/?gh_jid=123",
    "http://job-boards.greenhouse.io/example/jobs/123",
  ])
    assert.equal(greenhousePosting(invalid), null);
});
test("verified employer redirects use only the original job direct form and preserve canonical identity", async () => {
  const f = fixture();
  const external = "https://careers.example.com/job?gh_jid=123";
  const direct =
    "https://job-boards.greenhouse.io/embed/job_app?for=example&token=123";
  const calls: string[] = [];
  const read: CareersFetch = async (u) => {
    calls.push(u);
    const base = await reader(u);
    if (u.includes("boards-api"))
      return {
        ...base,
        text: JSON.stringify({ ...api, absolute_url: external }),
      };
    if (u === url)
      return {
        ...base,
        url: external,
        text: "<main>Employer careers page</main>",
      };
    assert.equal(u, direct);
    return base;
  };
  try {
    const saved = await generateAutofill(f.store, "one", read);
    assert.equal(saved.url, direct);
    assert.equal(calls.length, 3);
    assert.equal(savedAutofills(f.store, "one")[0].stale, false);
    assert.equal(
      f.store.opening("one")!.url,
      url,
      "keep the research-owned posting URL",
    );
    const evidence = JSON.parse(
      readFileSync(f.store.objectPath(saved.evidenceHash), "utf8"),
    );
    assert.equal(evidence.plan.url, direct);
    assert.equal(evidence.postingUrl, url);
    await assert.rejects(
      generateAutofill(f.store, "one", async (u) => {
        const response = await read(u);
        return u === url
          ? {
              ...response,
              url: "https://unverified.example.org/job?gh_jid=123",
            }
          : response;
      }),
      /different posting/,
    );
    await assert.rejects(
      generateAutofill(f.store, "one", async (u) => {
        const response = await read(u);
        return u === direct
          ? { ...response, url: direct.replace("token=123", "token=999") }
          : response;
      }),
      /redirected unexpectedly/,
    );
    await assert.rejects(
      generateAutofill(f.store, "one", async (u) => {
        const response = await read(u);
        return u === direct ? { ...response, status: 429 } : response;
      }),
      /limiting requests/,
    );
    assert.equal(
      f.store.list("application_autofill").length,
      1,
      "failed fallbacks never publish partial scripts",
    );
  } finally {
    f.cleanup();
  }
});
test("a documented employer redirect that only adds www still uses the direct form", async () => {
  const f = fixture();
  const external = "https://example.com/careers?gh_jid=123";
  const direct =
    "https://job-boards.greenhouse.io/embed/job_app?for=example&token=123";
  const read =
    (finalUrl: string): CareersFetch =>
    async (u) => {
      const base = await reader(u);
      if (u.includes("boards-api"))
        return {
          ...base,
          text: JSON.stringify({ ...api, absolute_url: external }),
        };
      if (u === url)
        return { ...base, url: finalUrl, text: "<main>Careers</main>" };
      assert.equal(u, direct);
      return base;
    };
  try {
    await assert.rejects(
      generateAutofill(
        f.store,
        "one",
        read("https://www.example.com/careers?gh_jid=999"),
      ),
      /different posting/,
    );
    const saved = await generateAutofill(
      f.store,
      "one",
      read("https://www.example.com/careers?gh_jid=123"),
    );
    assert.equal(saved.url, direct);
  } finally {
    f.cleanup();
  }
});
test("Greenhouse jobs without compliance questions send compliance: null and still get a script", async () => {
  const f = fixture();
  const withApi =
    (payload: object): CareersFetch =>
    async (u) => {
      const base = await reader(u);
      return u.includes("boards-api")
        ? { ...base, text: JSON.stringify(payload) }
        : base;
    };
  try {
    const saved = await generateAutofill(
      f.store,
      "one",
      withApi({ ...api, compliance: null }),
    );
    assert.equal(saved.url, url);
    await assert.rejects(
      generateAutofill(f.store, "one", withApi({ ...api, compliance: {} })),
      /invalid question list/,
    );
  } finally {
    f.cleanup();
  }
});
test("autofill status distinguishes active generation, Codex work, saving and stopped requests", () => {
  assert.equal(autofillActivity(true, []).phase, "reading-form");
  assert.equal(
    autofillActivity(false, [{ status: "running", autofillContext: {} }]).phase,
    "drafting",
  );
  assert.equal(
    autofillActivity(false, [
      {
        status: "completed",
        autofillContext: {},
        autofillResult: { status: "saving" },
      },
    ]).phase,
    "saving",
  );
  assert.match(
    autofillActivity(false, [
      { status: "waiting for input", autofillContext: {} },
    ]).message,
    /needs your input/,
  );
  const failed = autofillActivity(false, [
    {
      status: "failed",
      autofillContext: {},
      autofillResult: { status: "drafting" },
    },
  ]);
  assert.equal(failed.running, false);
  assert.match(failed.message, /No autofill generation is running/);
});
test("form-derived plan includes only confirmed answers and preserves unknown and required questions", () => {
  const plan = buildAutofillPlan(url, html, api, profile);
  assert.equal(plan.fields.find((f) => f.id === "question_auth")?.value, "Yes");
  assert.equal(
    plan.fields.find((f) => f.id === "question_sponsor")?.value,
    "No",
  );
  assert.equal(
    plan.fields.find((f) => f.id === "1234")?.value,
    "Decline to self-identify",
  );
  assert.equal(
    plan.fields.find((f) => f.id === "candidate-location")?.value,
    "Seattle, Washington, United States",
  );
  assert.ok(
    plan.review.some(
      (q) => q.required && q.label === "Are you willing to work weekends?",
    ),
  );
  assert.ok(plan.review.some((q) => q.required && q.label === "Resume/CV"));
  assert.ok(plan.review.some((q) => q.label === "Are you Hispanic/Latino?"));
  assert.ok(!plan.fields.some((f) => f.id === "hispanic_ethnicity"));
  assert.throws(
    () => buildAutofillPlan(url, "<main>Role closed</main>", api, profile),
    /no supported/,
  );
});
test("required checkbox groups are one question, not one requirement per unchecked choice", () => {
  const extra = {
    label: "How did you hear about us?",
    required: true,
    fields: [
      {
        name: "question_999[]",
        type: "multi_value_multi_select",
        values: [
          { label: "Website", value: 1 },
          { label: "Referral", value: 2 },
        ],
      },
    ],
  };
  const checkboxes =
    '<label for="question_999[]_1">Website</label><input type="checkbox" id="question_999[]_1" name="question_999[]" required><label for="question_999[]_2">Referral</label><input type="checkbox" id="question_999[]_2" name="question_999[]" required>';
  const plan = buildAutofillPlan(
    url,
    html.replace("</form>", checkboxes + "</form>"),
    { ...api, questions: [...api.questions, extra] },
    profile,
  );
  assert.equal(plan.review.filter((r) => r.label === extra.label).length, 1);
  assert.equal(
    plan.review.some((r) => r.label === "Website" || r.label === "Referral"),
    false,
  );
  assert.deepEqual(plan.controlGroups[0].ids, [
    "question_999[]_1",
    "question_999[]_2",
  ]);
  assert.equal(plan.controlGroups[0].required, true);
});
test("sensitive, inverse and ambiguous questions are never answered by keyword guessing", () => {
  for (const label of [
    "Are you NOT legally authorized to work in the United States?",
    "Are you a US citizen?",
    "Do you have a disability requiring accommodation?",
    "Are you a veteran or active member of the United States Armed Forces?",
  ]) {
    assert.equal(
      suggestAutofill(
        {
          id: "custom",
          label,
          kind: "select",
          required: false,
          options: ["Yes", "No"],
        },
        profile,
        "Example",
      ),
      null,
      label,
    );
  }
  assert.equal(
    suggestAutofill(
      {
        id: "custom",
        label: "Are you legally authorized to work in the United States?",
        kind: "select",
        required: true,
        options: ["Yes", "YES", "No"],
      },
      profile,
      "Example",
    ),
    null,
  );
});
test("second employer demographic wording uses the same confirmed profile without inferring ethnicity", () => {
  const field = (label: string, options: string[]) => ({
    id: "other-employer-question",
    label,
    options,
    required: false,
    kind: "select" as const,
  });
  assert.deepEqual(
    suggestAutofill(
      field("I identify my gender as:", ["Female", "Non-binary"]),
      profile,
      "Example",
    ),
    { value: "Non-binary" },
  );
  assert.deepEqual(
    suggestAutofill(
      field("Veteran Status:", [
        "Yes, I am a veteran",
        "No, I am not a veteran",
      ]),
      { ...profile, demographics: { ...profile.demographics, veteran: false } },
      "Example",
    ),
    { value: "No, I am not a veteran" },
  );
  assert.deepEqual(
    suggestAutofill(
      field(
        "Do you identify as a person with a disability of any kind, visible or invisible?",
        ["Yes", "No"],
      ),
      profile,
      "Example",
    ),
    { value: "No" },
  );
  const race =
    "Which of the following best represents your racial or ethnic background: (Check more than one if that is how you identify)";
  assert.deepEqual(
    suggestAutofill(
      field(race, ["Decline to self-identify", "Hispanic"]),
      profile,
      "Example",
    ),
    { value: "Decline to self-identify" },
  );
  assert.equal(
    suggestAutofill(
      field(race, ["White (Not Hispanic or Latino)", "Hispanic"]),
      profile,
      "Example",
    ),
    null,
  );
});
test("confirmed profile links and non-Hispanic answer fill exact fields, including conditional race", () => {
  const p = {
    ...profile,
    linkedIn: "https://www.linkedin.com/in/test/",
    github: "https://github.com/test",
    website: "https://github.com/test",
    demographics: {
      ...profile.demographics,
      hispanicLatino: false,
      race: "Asian",
    },
  };
  const field = (label: string) => ({
    id: "question_456",
    label,
    options: [],
    required: false,
    kind: "text" as const,
  });
  assert.equal(
    suggestAutofill(field("LinkedIn Profile"), p, "Example")?.value,
    p.linkedIn,
  );
  assert.equal(
    suggestAutofill(field("Website"), p, "Example")?.value,
    p.website,
  );
  assert.equal(suggestAutofill(field("GitHub"), p, "Example")?.value, p.github);
  const withRace = {
    ...api,
    compliance: [{ questions: [question("race", "Race", ["Black", "Asian"])] }],
  };
  const plan = buildAutofillPlan(url, html, withRace, p);
  assert.equal(
    plan.fields.find((f) => f.id === "hispanic_ethnicity")?.value,
    "No",
  );
  assert.equal(plan.fields.find((f) => f.id === "race")?.value, "Asian");
  assert.equal(plan.fields.find((f) => f.id === "race")?.conditional, true);
});
test("preferred name and school defaults are reusable without replacing legal name or choosing a different campus", () => {
  const p = {
    ...profile,
    preferredFirstName: "Preferred",
    school: "Cascadia University - Main Campus",
  };
  const f = {
    id: "preferred_name",
    label: "Preferred First Name",
    kind: "text" as const,
    required: false,
    options: [],
  };
  assert.equal(suggestAutofill(f, p, "Example")?.value, "Preferred");
  assert.equal(
    suggestAutofill(
      { ...f, id: "first_name", label: "First Name" },
      p,
      "Example",
    )?.value,
    profile.firstName,
  );
  const school = {
    ...f,
    id: "school--0",
    label: "School",
    kind: "select" as const,
    required: true,
  };
  assert.deepEqual(suggestAutofill(school, p, "Example"), {
    value: p.school,
    search: p.school,
  });
  assert.equal(
    suggestAutofill(
      { ...school, options: ["Cascadia University - North Campus"] },
      p,
      "Example",
    ),
    null,
  );
  assert.deepEqual(
    suggestAutofill(
      {
        ...school,
        options: [
          "Cascadia University Main Campus",
          "Cascadia University - North Campus",
        ],
      },
      p,
      "Example",
    ),
    { value: "Cascadia University Main Campus" },
  );
  assert.equal(
    suggestAutofill({ ...school, id: "school--1" }, p, "Example"),
    null,
  );
  assert.equal(suggestAutofill(school, profile, "Example"), null);
});
test("current US work authorization and employer-named sponsorship questions use confirmed reusable answers", () => {
  const f = {
    id: "question_123",
    label: "Are you currently legally authorized to work in the United States?",
    kind: "select" as const,
    required: true,
    options: ["Yes", "No"],
  };
  assert.equal(suggestAutofill(f, profile, "Fabrikam")?.value, "Yes");
  for (const company of ["Fabrikam", "Example Inc.", "Another Employer"]) {
    const label = `Will you now or in the future require ${company} to sponsor or support an employment visa or work authorization in order to work in the United States?`;
    assert.equal(
      suggestAutofill({ ...f, label }, profile, company)?.value,
      "No",
    );
    assert.equal(
      suggestAutofill(
        { ...f, label },
        { ...profile, requiresSponsorshipNowOrFuture: null },
        company,
      ),
      null,
    );
    // The saved sponsorship answer applies regardless of the named country.
    assert.equal(
      suggestAutofill(
        { ...f, label: label.replace("United States", "Canada") },
        profile,
        company,
      )?.value,
      "No",
    );
  }
  assert.equal(
    suggestAutofill(
      {
        ...f,
        label:
          "Are you currently NOT legally authorized to work in the United States?",
      },
      profile,
      "Fabrikam",
    ),
    null,
  );
});
test("generated scripts persist immutably, survive backups, escape source text and track changed answers", async () => {
  const f = fixture();
  try {
    const hostile = {
      ...profile,
      firstName: 'Test"; globalThis.unwanted = true; //',
    };
    atomicWrite(f.profileFile, JSON.stringify(hostile));
    const first = await generateAutofill(f.store, "one", reader);
    const source = savedAutofillScript(f.store, "one", first.id).script;
    assert.doesNotThrow(() => new Script(source));
    assert.ok(source.includes(JSON.stringify(hostile.firstName)));
    assert.equal(savedAutofills(f.store, "one")[0].stale, false);
    f.store.put("application_autofill", first.id, {
      ...first,
      helperHash: "an-older-embedded-helper-version",
    });
    assert.equal(savedAutofills(f.store, "one")[0].stale, false);
    assert.equal(savedAutofillScript(f.store, "one", first.id).script, source);
    atomicWrite(f.profileFile, JSON.stringify(profile));
    assert.equal(savedAutofills(f.store, "one")[0].stale, true);
    const second = await generateAutofill(f.store, "one", reader);
    assert.equal(second.version, 2);
    assert.equal(savedAutofillScript(f.store, "one", first.id).script, source);
    assert.notEqual(first.scriptHash, second.scriptHash);
    assert.equal(
      f.store.list("application").length,
      0,
      "generating code must not start or submit an application",
    );
    const zip = unzipSync(f.store.backup());
    assert.ok(zip[`objects/${first.scriptHash}`]);
    assert.ok(zip[`objects/${first.evidenceHash}`]);
    assert.equal(
      f.store.personalExport().records.application_autofill.length,
      2,
    );
    assert.throws(
      () => savedAutofillScript(f.store, "other", first.id),
      /not found/,
    );
    atomicWrite(f.store.objectPath(first.scriptHash), "tampered");
    assert.throws(
      () => savedAutofillScript(f.store, "one", first.id),
      /integrity/,
    );
  } finally {
    f.cleanup();
  }
});
test("generation failures identify the listing and preserve HTTP status and saved scripts", async () => {
  const f = fixture();
  try {
    f.store.put(
      "cache_opening",
      "one" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...f.store.opening("one"),
        company: "Example Company",
      } as Records["cache_opening"],
    );
    const saved = await generateAutofill(f.store, "one", reader);
    await assert.rejects(
      generateAutofill(f.store, "one", async () => {
        throw new Error("Network unavailable");
      }),
      (error) => {
        assert.equal((error as any).status, 422);
        assert.match(
          (error as Error).message,
          /^Example Company · Engineer: Could not read the current Greenhouse form: Error: Network unavailable\./,
        );
        return true;
      },
    );
    await assert.rejects(
      generateAutofill(f.store, "one", async (u) => ({
        ...(await reader(u)),
        status: u.includes("boards-api") ? 404 : 200,
      })),
      /Example Company · Engineer: Greenhouse no longer has this posting \(HTTP 404\), so it looks closed\. Validate openings/,
    );
    await assert.rejects(
      generateAutofill(f.store, "one", async (u) => ({
        ...(await reader(u)),
        status: 429,
      })),
      (error) => {
        assert.equal((error as any).status, 429);
        assert.match(
          (error as Error).message,
          /^Example Company · Engineer: Greenhouse is limiting requests\./,
        );
        return true;
      },
    );
    assert.deepEqual(
      f.store.list("application_autofill").map((r) => r.id),
      [saved.id],
    );
  } finally {
    f.cleanup();
  }
});

test("rate limits, redirects, identity mismatches and changing profiles do not publish partial scripts", async () => {
  const f = fixture();
  try {
    for (const status of [404, 429, 500])
      await assert.rejects(
        generateAutofill(f.store, "one", async (u) => ({
          ...(await reader(u)),
          status,
        })),
        /Greenhouse/,
      );
    await assert.rejects(
      generateAutofill(f.store, "one", async (u) => ({
        ...(await reader(u)),
        url: "https://job-boards.greenhouse.io/example/jobs/999",
      })),
      /different posting/,
    );
    await assert.rejects(
      generateAutofill(f.store, "one", async (u) => ({
        ...(await reader(u)),
        ...(u.includes("boards-api")
          ? { text: JSON.stringify({ ...api, id: 999 }) }
          : {}),
      })),
      /different or invalid/,
    );
    await assert.rejects(
      generateAutofill(f.store, "one", async (u) => {
        atomicWrite(
          f.profileFile,
          JSON.stringify({ ...profile, firstName: "Changed" }),
        );
        return reader(u);
      }),
      /changed during/,
    );
    assert.equal(f.store.list("application_autofill").length, 0);
  } finally {
    f.cleanup();
  }
});
