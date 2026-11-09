import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { atomicWrite } from "../server/storage.js";
import {
  generateAutofill,
  savedAutofillScript,
} from "../server/greenhouse-autofill.js";
import { referenceLetterPdf } from "../server/autofill/reference-letter.js";
import { formQuestionCounts } from "../server/autofill/form-questions.js";
import { readAutofillProfile } from "../server/autofill/profile.js";

const letter = Buffer.from("%PDF-1.4\nSynthetic recommendation letter");

// Markup as the hosted form renders a custom upload question (Woodgrove, 2026-10-31).
const upload = (id: string, label: string) =>
  `<div role="group" aria-labelledby="upload-label-${id}" aria-required="false" class="file-upload"><div id="upload-label-${id}" class="label upload-label">${label}</div><button type="button">Attach</button><label class="visually-hidden" for="${id}">Attach</label><input id="${id}" class="visually-hidden" type="file" accept=".pdf,.doc,.docx,.txt,.rtf"></div>`;

function uploadFixture() {
  const f = applicationAnswerFixture();
  f.api.questions.push(
    {
      label: "Upload anything",
      required: false,
      fields: [{ name: "question_789", type: "input_file" }],
    },
    {
      label: "Portfolio",
      required: false,
      fields: [{ name: "question_790", type: "input_file" }],
    },
  );
  f.form.html = f.form.html.replace(
    "</form>",
    `${upload("question_789", "Upload anything")}${upload("question_790", "Portfolio")}</form>`,
  );
  return f;
}

test("a catch-all upload gets the recommendation letter and other uploads stay manual", async () => {
  const f = uploadFixture();
  try {
    atomicWrite(path.join(f.root, referenceLetterPdf), letter);
    const record = await generateAutofill(f.store, "one", f.read);
    assert.deepEqual(
      record.sourceAttachments?.map((a) => [a.id, a.label, a.name]),
      [["question_789", "Upload anything", "reference_letter.pdf"]],
    );
    assert.equal(
      record.attachments?.length,
      0,
      "no Opening document is claimed",
    );
    assert.ok(!record.review.some((item) => item.label === "Upload anything"));
    assert.ok(
      record.review.some((item) => item.label === "Portfolio"),
      "a portfolio upload is not a catch-all and keeps its own label",
    );
    const { script } = savedAutofillScript(f.store, "one", record.id);
    assert.ok(script.includes(letter.toString("base64")));
    assert.ok(script.includes('"id": "question_789"'));
    assert.deepEqual(
      formQuestionCounts(
        record.url,
        f.form.html,
        f.api,
        readAutofillProfile(f.store).profile,
      )
        .personal.map((item) => item.label)
        .filter((label) => label.includes("Upload") || label === "Portfolio"),
      ["Portfolio"],
      "the estimate leaves the letter's upload out of the personal questions",
    );
  } finally {
    f.cleanup();
  }
});

test("without the letter file the catch-all upload stays for manual review", async () => {
  const f = uploadFixture();
  try {
    const record = await generateAutofill(f.store, "one", f.read);
    assert.equal(record.sourceAttachments, undefined);
    assert.ok(record.review.some((item) => item.label === "Upload anything"));
  } finally {
    f.cleanup();
  }
});
