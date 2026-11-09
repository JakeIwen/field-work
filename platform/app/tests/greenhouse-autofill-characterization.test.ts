import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Records } from "../server/records.js";
import { atomicWrite, HttpError, sha256, Store } from "../server/storage.js";
import type { CareersFetch, CareersResponse } from "../server/careers/http.js";
import {
  generateAutofill,
  greenhouseForm,
  savedAutofillScript,
} from "../server/greenhouse-autofill.js";

const postingUrl = "https://job-boards.greenhouse.io/example/jobs/123";

type ApiValue = { label: string; value: string | number };
type ApiField = {
  name: string;
  type: string;
  values?: ApiValue[];
};
type ApiQuestion = {
  label: string;
  required?: boolean;
  description?: string;
  fields: ApiField[];
};
type DemographicQuestion = {
  id: number;
  label: string;
  required?: boolean;
  description?: string;
  answer_options: { label: string; free_form: boolean }[];
};
type GreenhouseApi = {
  id: number;
  title: string;
  company_name: string;
  questions: ApiQuestion[];
  location_questions?: ApiQuestion[];
  compliance?: { questions: ApiQuestion[] }[];
  demographic_questions?: { questions: DemographicQuestion[] };
};

const profile = {
  version: 1,
  firstName: "Test",
  lastName: "Applicant",
  email: "test@example.com",
  phone: "5555550100",
  location: { city: "Seattle", state: "WA", country: "US" },
  authorizedToWorkUS: true,
  requiresSponsorshipNowOrFuture: false,
};

const question = (
  name: string,
  label: string,
  values: ApiValue[] = [],
  required = false,
  description?: string,
): ApiQuestion => ({
  label,
  required,
  fields: [
    {
      name,
      type: values.length ? "multi_value_single_select" : "input_text",
      values,
    },
  ],
  ...(description ? { description } : {}),
});

const combinedApi: GreenhouseApi = {
  id: 44,
  title: "Engineer",
  company_name: "Example Company",
  questions: [
    question("first_name", " First * Name ", [], true),
    question("email", " Email * ", [], true),
    question(
      "about",
      " About * ",
      [],
      false,
      "<p>Tell us your <strong>preferred</strong> name.</p>",
    ),
    question("skills[]", " Skills * ", [
      { label: " TypeScript * ", value: "typescript" },
      { label: " Node.js ", value: "node" },
    ]),
    question(
      "work_mode",
      " Work mode * ",
      [
        { label: " Remote ", value: "remote" },
        { label: " Hybrid ", value: "hybrid" },
      ],
      true,
    ),
  ],
  location_questions: [
    question("location", " Where are you located? * ", [], true),
  ],
  compliance: [
    {
      questions: [
        question(
          "work_authorization",
          " Work authorization * ",
          [
            { label: " Yes * ", value: "yes" },
            { label: " No ", value: "no" },
          ],
          true,
        ),
        question("race", " Race ", [
          { label: " White * ", value: "white" },
          { label: " Asian ", value: "asian" },
        ]),
      ],
    },
  ],
  demographic_questions: {
    questions: [
      {
        id: 900,
        label: " Demographic identity * ",
        description: "<p>Optional <em>demographic</em> context.</p>",
        answer_options: [
          { label: " White * ", free_form: false },
          { label: " Self describe ", free_form: true },
        ],
      },
    ],
  },
};

const combinedHtml = `
  <form id="application-form">
    <label for="ignored-hidden">Ignored hidden</label><input id="ignored-hidden" type="hidden">
    <label for="ignored-search">Ignored search</label><input id="ignored-search" type="search">
    <label for="ignored-aria">Ignored aria</label><input id="ignored-aria" aria-hidden="true">
    <label for="first_name">First * Name *</label><input id="first_name">
    <label for="email">Email *</label><input id="email" type="email">
    <label for="about">About *</label><textarea id="about"></textarea>
    <label for="candidate-location">Location (City) *</label><input id="candidate-location" role="combobox" aria-required="true">
    <label for="work_authorization">Work authorization *</label><input id="work_authorization" role="combobox">
    <label for="900">Demographic identity *</label><select id="900"><option> White * </option><option> Self describe </option></select>
    <label for="hispanic_ethnicity">Are you Hispanic/Latino?</label><input id="hispanic_ethnicity" role="combobox">
    <label for="native_select">Native select</label><select id="native_select"><option> First * option </option><option> Second option </option></select>
    <label for="long-default">Long default</label><input id="long-default">
    <label for="long-capped">Long capped</label><input id="long-capped" maxlength="12001">
    <label for="medium">Medium</label><input id="medium" maxlength="42">
    <label for="resume">Resume upload *</label><input id="resume" type="file" required>
    <label for="cover_letter">Cover letter upload *</label><input id="cover_letter" type="file" required>
    <label for="skills-js">TypeScript *</label><input id="skills-js" name="skills[]" type="checkbox">
    <label for="skills-node">Node.js</label><input id="skills-node" name="skills[]" type="checkbox">
    <label for="mode-remote">Remote</label><input id="mode-remote" name="work_mode" type="radio">
    <label for="mode-hybrid">Hybrid</label><input id="mode-hybrid" name="work_mode" type="radio">
    <label for="manual-consent">Manual consent</label><input id="manual-consent" type="checkbox">
    <label for="manual-button">Manual button</label><input id="manual-button" type="button">
    <label for="submit-control">Submit application</label><input id="submit-control" type="submit">
  </form>
`;

function expectHttpError(
  action: () => unknown,
  status: number,
  message: string,
): void {
  assert.throws(action, (error: unknown) => {
    if (!(error instanceof HttpError)) return false;
    assert.equal(error.status, status);
    assert.equal(error.message, message);
    return true;
  });
}

test("greenhouseForm pins combined API, DOM, review, and conditional outputs", () => {
  assert.deepEqual(greenhouseForm(combinedHtml, combinedApi), {
    fields: [
      {
        id: "first_name",
        label: "First Name",
        kind: "text",
        required: true,
        options: [],
        inputType: undefined,
        maxLength: 8000,
      },
      {
        id: "email",
        label: "Email",
        kind: "text",
        required: true,
        options: [],
        inputType: "email",
        maxLength: 8000,
      },
      {
        id: "about",
        label: "About",
        kind: "textarea",
        required: false,
        options: [],
        description: "Tell us your preferred name.",
        inputType: undefined,
        maxLength: 8000,
      },
      {
        id: "candidate-location",
        label: "Location (City)",
        kind: "select",
        required: true,
        options: [],
        inputType: undefined,
        maxLength: 8000,
      },
      {
        id: "work_authorization",
        label: "Work authorization",
        kind: "select",
        required: true,
        options: ["Yes", "No"],
        inputType: undefined,
        maxLength: 8000,
      },
      {
        id: "900",
        label: "Demographic identity",
        kind: "select",
        required: false,
        options: ["White"],
        description: "Optional demographic context.",
        profileOnly: true,
        inputType: undefined,
        maxLength: 8000,
      },
      {
        id: "hispanic_ethnicity",
        label: "Are you Hispanic/Latino?",
        kind: "select",
        required: false,
        options: ["Yes", "No", "Decline To Self Identify"],
        inputType: undefined,
        maxLength: 8000,
      },
      {
        id: "native_select",
        label: "Native select",
        kind: "select",
        required: false,
        options: ["First option", "Second option"],
        inputType: undefined,
        maxLength: 8000,
      },
      {
        id: "long-default",
        label: "Long default",
        kind: "text",
        required: false,
        options: [],
        inputType: undefined,
        maxLength: 8000,
      },
      {
        id: "long-capped",
        label: "Long capped",
        kind: "text",
        required: false,
        options: [],
        inputType: undefined,
        maxLength: 12000,
      },
      {
        id: "medium",
        label: "Medium",
        kind: "text",
        required: false,
        options: [],
        inputType: undefined,
        maxLength: 42,
      },
      {
        id: "race",
        label: "Please identify your race",
        kind: "select",
        required: false,
        options: ["White", "Asian"],
        conditional: true,
      },
    ],
    review: [
      {
        label: "Resume/CV",
        required: true,
        reason: "Attach your document on the application page.",
      },
      {
        label: "Cover letter",
        required: true,
        reason: "Attach your document on the application page.",
      },
      {
        label: "Skills",
        required: false,
        reason: "Choose the applicable option on the application page.",
      },
      {
        label: "Work mode",
        required: true,
        reason: "Choose the applicable option on the application page.",
      },
      {
        label: "Manual consent",
        required: false,
        reason: "Complete this control yourself.",
      },
      {
        label: "Manual button",
        required: false,
        reason: "Complete this control yourself.",
      },
      {
        label: "Submit application",
        required: false,
        reason: "Complete this control yourself.",
      },
    ],
    controlGroups: [
      {
        name: "skills[]",
        ids: ["skills-js", "skills-node"],
        label: "Skills",
        required: false,
        choices: [
          { id: "skills-js", label: "TypeScript", kind: "checkbox" },
          { id: "skills-node", label: "Node.js", kind: "checkbox" },
        ],
      },
      {
        name: "work_mode",
        ids: ["mode-remote", "mode-hybrid"],
        label: "Work mode",
        required: true,
        choices: [
          { id: "mode-remote", label: "Remote", kind: "radio" },
          { id: "mode-hybrid", label: "Hybrid", kind: "radio" },
        ],
      },
    ],
  });
});

const duplicateForm = `<form id="application-form"><label for="first_name">First name</label><input id="first_name"><label for="first_name">Duplicate first name</label><input id="first_name"><label for="email">Email</label><input id="email"></form>`;
const tooManyFields = `<form id="application-form">${Array.from(
  { length: 151 },
  (_, index) =>
    `<label for="field-${index}">Field ${index}</label><input id="field-${index}">`,
).join(
  "",
)}<label for="first_name">First name</label><input id="first_name"><label for="email">Email</label><input id="email"></form>`;
const parserErrorCases: {
  name: string;
  html: string;
  api: GreenhouseApi;
  message: string;
}[] = [
  {
    name: "questions missing",
    html: combinedHtml,
    api: { ...combinedApi, questions: [] },
    message: "Greenhouse did not return application questions.",
  },
  {
    name: "wrong form count",
    html: `<form id="application-form"></form><form id="application-form"></form>`,
    api: combinedApi,
    message:
      "This posting has no supported Greenhouse application form. It may be closed or use an embedded form.",
  },
  {
    name: "duplicate accepted ID",
    html: duplicateForm,
    api: combinedApi,
    message:
      "The application has duplicate field identifiers; inspect it manually.",
  },
  {
    name: "first_name or email absent",
    html: `<form id="application-form"><label for="first_name">First name</label><input id="first_name"></form>`,
    api: combinedApi,
    message: "The application form could not be verified.",
  },
  {
    name: "more than 150 fields",
    html: tooManyFields,
    api: combinedApi,
    message: "This application has too many fields for autofill.",
  },
];

for (const parserError of parserErrorCases)
  test(`greenhouseForm parser error: ${parserError.name}`, () => {
    expectHttpError(
      () => greenhouseForm(parserError.html, parserError.api),
      422,
      parserError.message,
    );
  });

type Fixture = {
  store: Store;
  opening: Records["cache_opening"];
  cleanup: () => void;
};

function makeOpening(
  id: string,
  url: string,
  jobId: string,
  hash: string,
): Records["cache_opening"] {
  return {
    id,
    company_id: "example-company",
    company: "Example Company",
    job_id: jobId,
    title: "Engineer",
    url,
    technical_fit: "Unknown",
    remote_fit: "Unknown",
    wlb_outlook: "Unknown",
    location: "Remote",
    compensation: "Unknown",
    why: "Synthetic fixture",
    concerns: "None",
    requirements: "None",
    wlb_evidence: "None",
    status: "new",
    first_seen: null,
    last_confirmed_open: null,
    deadline: null,
    postingStatus: "open",
    sourcePath: "source_data/synthetic.md",
    sourceDate: null,
    hash,
  };
}

function fixture(): Fixture {
  const root = mkdtempSync(
    path.join(os.tmpdir(), "greenhouse-autofill-characterization-"),
  );
  const store = new Store(root, path.join(root, ".local/data"));
  atomicWrite(
    path.join(root, ".local/greenhouse/profile.json"),
    JSON.stringify(profile),
  );
  const opening = makeOpening("one", postingUrl, "123", "opening-one");
  store.put("cache_opening", opening.id, opening);
  return {
    store,
    opening,
    cleanup: () => {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function generationApi(jobId: number): GreenhouseApi {
  return {
    id: jobId,
    title: "Engineer",
    company_name: "Example Company",
    questions: [
      question("first_name", "First Name", [], true),
      question("email", "Email", [], true),
    ],
  };
}

const generationHtml = `<form id="application-form"><label for="first_name">First Name</label><input id="first_name"><label for="email">Email</label><input id="email" type="email"></form>`;

function generationResponse(
  requestedUrl: string,
  jobId: number,
  overrides: Partial<CareersResponse> = {},
): CareersResponse {
  const isApi = requestedUrl.includes("boards-api");
  return {
    url: requestedUrl,
    requestedUrl,
    status: 200,
    type: isApi ? "application/json" : "text/html",
    text: isApi ? JSON.stringify(generationApi(jobId)) : generationHtml,
    at: "2026-10-04T00:00:00.000Z",
    ...overrides,
  };
}

const reader: CareersFetch = async (requestedUrl) =>
  generationResponse(requestedUrl, requestedUrl.includes("/456?") ? 456 : 123);

async function assertGenerationError(
  f: Fixture,
  read: CareersFetch,
  message: string,
  status = 422,
): Promise<void> {
  await assert.rejects(
    generateAutofill(f.store, "one", read),
    (error: unknown) => {
      if (!(error instanceof HttpError)) return false;
      assert.equal(error.status, status);
      assert.equal(error.message, message);
      return true;
    },
  );
}

test("generation gives API 429 precedence over a rejected HTML read and waits for both results", async () => {
  const f = fixture();
  try {
    let releaseHtml: (() => void) | undefined;
    let htmlFinished = false;
    const htmlReleased = new Promise<void>((resolve) => {
      releaseHtml = resolve;
    });
    const read: CareersFetch = async (requestedUrl) => {
      if (requestedUrl.includes("boards-api"))
        return generationResponse(requestedUrl, 123, { status: 429 });
      await htmlReleased;
      htmlFinished = true;
      throw new Error("HTML failed");
    };
    const pending = generateAutofill(f.store, "one", read);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(htmlFinished, false);
    if (!releaseHtml) throw new Error("HTML release was not initialized");
    releaseHtml();
    await assert.rejects(pending, (error: unknown) => {
      if (!(error instanceof HttpError)) return false;
      assert.equal(error.status, 429);
      assert.equal(
        error.message,
        "Example Company · Engineer: Greenhouse is limiting requests. Wait before trying again; your saved scripts are unchanged.",
      );
      return true;
    });
    assert.equal(htmlFinished, true);
  } finally {
    f.cleanup();
  }
});

test("generation gives an API rejection precedence over an HTML 429", async () => {
  const f = fixture();
  try {
    const read: CareersFetch = async (requestedUrl) => {
      if (requestedUrl.includes("boards-api")) throw new Error("API failed");
      return generationResponse(requestedUrl, 123, { status: 429 });
    };
    await assertGenerationError(
      f,
      read,
      "Example Company · Engineer: Could not read the current Greenhouse form: Error: API failed. Your saved scripts are unchanged; try again later.",
    );
  } finally {
    f.cleanup();
  }
});

test("generation pins wrapped malformed API JSON, missing opening, and invalid URL errors", async () => {
  const f = fixture();
  try {
    await assertGenerationError(
      f,
      async (requestedUrl) =>
        generationResponse(requestedUrl, 123, {
          text: requestedUrl.includes("boards-api") ? "{" : generationHtml,
        }),
      "Example Company · Engineer: Greenhouse returned an unreadable question list.",
    );
    await assert.rejects(
      generateAutofill(f.store, "missing", reader),
      (error: unknown) => {
        if (!(error instanceof HttpError)) return false;
        assert.equal(error.status, 404);
        assert.equal(error.message, "missing: Opening not found");
        return true;
      },
    );
    const invalid = makeOpening(
      "invalid",
      "https://example.com/jobs/123",
      "123",
      "opening-invalid",
    );
    f.store.put("cache_opening", invalid.id, invalid);
    await assert.rejects(
      generateAutofill(f.store, "invalid", reader),
      (error: unknown) => {
        if (!(error instanceof HttpError)) return false;
        assert.equal(error.status, 422);
        assert.equal(
          error.message,
          "Example Company · Engineer: Use a supported hosted application URL to generate an autofill script.",
        );
        return true;
      },
    );
  } finally {
    f.cleanup();
  }
});

test("successful generation pins persistence relationships, opening-scoped versions, ordering, and no application mutation", async () => {
  const f = fixture();
  try {
    const second = makeOpening(
      "two",
      "https://job-boards.greenhouse.io/example/jobs/456",
      "456",
      "opening-two",
    );
    f.store.put("cache_opening", second.id, second);
    const beforeOpening = f.store.opening("one");
    const beforeApplications = f.store.list("application");
    const events: string[] = [];
    const originalPut = f.store.put.bind(f.store);
    f.store.put = <K extends keyof Records>(
      kind: K,
      id: string,
      value: Records[K],
    ) => {
      events.push(`put:${String(kind)}`);
      return originalPut(kind, id, value);
    };
    const originalJournal = f.store.journal.bind(f.store);
    f.store.journal = (
      type: string,
      message: string,
      entityId?: string,
      details?: unknown,
    ) => {
      events.push(`journal:${type}`);
      return originalJournal(type, message, entityId, details);
    };

    const first = await generateAutofill(f.store, "one", reader);
    assert.equal(f.store.state().openingAutofillScriptIds?.one, first.id);
    const other = await generateAutofill(f.store, "two", reader);
    assert.equal(f.store.state().openingAutofillScriptIds?.two, other.id);
    const firstAgain = await generateAutofill(f.store, "one", reader);

    assert.equal(first.version, 1);
    assert.equal(other.version, 1);
    assert.equal(firstAgain.version, 2);
    assert.deepEqual(f.store.opening("one"), beforeOpening);
    assert.deepEqual(f.store.list("application"), beforeApplications);

    const firstStored = f.store.get("application_autofill", first.id);
    const persistedFirst = JSON.parse(
      JSON.stringify(first),
    ) as Records["application_autofill"];
    assert.deepEqual(firstStored, persistedFirst);
    const saved = savedAutofillScript(f.store, "one", first.id);
    assert.deepEqual(saved.record, persistedFirst);
    assert.equal(sha256(saved.script), first.scriptHash);
    assert.match(saved.script, /Fieldwork autofill/);

    const evidenceText = readFileSync(
      f.store.objectPath(first.evidenceHash),
      "utf8",
    );
    assert.equal(sha256(evidenceText), first.evidenceHash);
    const evidence = JSON.parse(evidenceText) as {
      apiUrl: string;
      url: string;
      postingUrl: string;
      sourceHash: string;
      plan: { url: string };
    };
    assert.equal(
      evidence.apiUrl,
      "https://boards-api.greenhouse.io/v1/boards/example/jobs/123?questions=true&pay_transparency=true",
    );
    assert.equal(evidence.url, first.url);
    assert.equal(evidence.postingUrl, postingUrl);
    assert.equal(evidence.plan.url, first.url);
    assert.equal(evidence.sourceHash, first.sourceHash);
    assert.equal(f.store.get("application_autofill", other.id)?.version, 1);
    assert.equal(
      f.store.list("application_autofill").filter((r) => r.openingId === "one")
        .length,
      2,
    );
    assert.equal(
      f.store.list("application_autofill").filter((r) => r.openingId === "two")
        .length,
      1,
    );

    assert.ok(events.includes("put:application_autofill"));
    assert.equal(events.includes("journal:application-autofill"), false);
    assert.deepEqual(f.store.state().openingAutofillScriptIds, {
      one: firstAgain.id,
      two: other.id,
    });
    f.store.remove("application_autofill", firstAgain.id);
    assert.equal(f.store.state().openingAutofillScriptIds?.one, first.id);
  } finally {
    f.cleanup();
  }
});
