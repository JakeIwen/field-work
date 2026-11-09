import assert from "node:assert/strict";
import test from "node:test";
import { formQuestionCounts } from "../server/autofill/form-questions.js";
import { readAutofillProfile } from "../server/autofill/profile.js";
import { autofillPreparationView } from "../shared/greenhouse-autofill.js";
import { answersPreparationFixture } from "./fixtures/answers-preparation.js";
import { url, label } from "./fixtures/application-answers-fixture.js";

test("personal form questions equal the answers-only finish list before any model flags", async () => {
  const f = answersPreparationFixture();
  f.payload.answers[0].manualReviewRequired = false;
  f.payload.answers[0].reviewReason = "";
  f.form.html = f.form.html.replace(
    "</form>",
    '<label for="declaration">I certify these answers are true</label><input id="declaration" type="checkbox"><label for="portfolio">Portfolio upload</label><input id="portfolio" type="file"></form>',
  );
  try {
    const { profile } = readAutofillProfile(f.store);
    const counts = formQuestionCounts(url, f.form.html, f.api, profile);
    assert.equal(counts.narrative, 1);
    assert.deepEqual(
      counts.personal.map((item) => item.label),
      ["I certify these answers are true", "Portfolio upload"],
    );
    assert.ok(counts.personal.every((item) => item.reason.length > 0));
    assert.ok(
      !counts.personal.some((item) =>
        [label, "Resume/CV", "Cover letter", "First Name", "Email"].includes(
          item.label,
        ),
      ),
    );
    assert.deepEqual(f.answerTurns, [], "inspection itself must never draft");
    f.manager.start("one", undefined, "answers");
    const { run } = await f.advance();
    assert.equal(run.status, "ready", run.error);
    const script = f.store.get("application_autofill", run.scriptId ?? "");
    assert.ok(script);
    assert.deepEqual(
      autofillPreparationView(script, run).answersOnlyFinishItems.map(
        ({ label, reason }) => ({ label, reason }),
      ),
      counts.personal,
    );
    assert.deepEqual(
      formQuestionCounts(url, f.form.html, f.api, profile),
      counts,
      "saved drafts must not change deterministic counts",
    );
    const prohibited = formQuestionCounts(
      url,
      f.form.html,
      { ...f.api, content: "Do not use AI to answer application questions." },
      profile,
    );
    assert.equal(prohibited.narrative, 0);
    assert.ok(prohibited.personal.some((item) => item.label === label));
  } finally {
    await f.close();
  }
});
