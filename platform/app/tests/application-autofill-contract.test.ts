import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import {
  applicationAutofillProviders,
  supportsApplicationAutofill,
} from "../server/application-autofill-providers.js";
import {
  applicationFormQuestionIdentity,
  type ApplicationFormField,
} from "../shared/application-form.js";

test("autofill registers only Greenhouse with packaged helpers", () => {
  assert.deepEqual(Object.keys(applicationAutofillProviders).sort(), [
    "greenhouse",
  ]);
  for (const [name, registration] of Object.entries(
    applicationAutofillProviders,
  )) {
    assert.equal(registration.provider, name);
    assert.ok(existsSync(registration.helperFile), `${name} helper is missing`);
  }
  assert.equal(
    supportsApplicationAutofill("https://example.invalid/jobs/123"),
    false,
  );
});

const fullName: ApplicationFormField = {
  stableId: "greenhouse:question_1",
  providerFieldId: "question_1",
  locator: { kind: "id", id: "question_1" },
  label: "Full name",
  section: {
    id: "contact",
    label: "Contact",
    instructions: "Use your legal name.",
  },
  required: true,
  semanticRole: "full-name",
  kind: "text",
  handling: "scalar",
  constraints: { maxLength: 120 },
};

test("application form question identity keeps semantics separate from DOM locators", () => {
  assert.deepEqual(applicationFormQuestionIdentity("greenhouse", fullName), {
    provider: "greenhouse",
    stableId: "greenhouse:question_1",
    providerFieldId: "question_1",
    label: "Full name",
    kind: "text",
    required: true,
    section: {
      id: "contact",
      label: "Contact",
      instructions: "Use your legal name.",
    },
    constraints: { maxLength: 120 },
    semanticRole: "full-name",
  });
});
