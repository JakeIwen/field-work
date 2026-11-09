import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { atomicWrite } from "../server/storage.js";
import { answersPreparationFixture } from "./fixtures/answers-preparation.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { legacyOpening } from "./fixtures/legacy-records.js";
import { ApplicationPreparationManager } from "../server/application-preparation.js";
import { openingAutofillCounts } from "../server/autofill/validity.js";
import {
  autofillPreparationView,
  attachDocumentReason,
} from "../shared/greenhouse-autofill.js";
import { withReadCache } from "../server/storage-read-cache.js";
import { source } from "./fixtures/application-answers-fixture.js";

test("answers-only skips PDFs and Applications, then a full run reuses unchanged answers without a second drafting turn", async () => {
  const f = answersPreparationFixture();
  f.payload.answers[0].manualReviewRequired = false;
  f.payload.answers[0].reviewReason = "";
  try {
    const first = f.manager.start("one", undefined, "answers");
    assert.equal(first.scope, "answers");
    assert.equal(first.applicationId, undefined);
    assert.equal(
      f.manager.start("one").id,
      first.id,
      "full requests deduplicate against busy answers work",
    );
    const { run, phases } = await f.advance();
    assert.equal(run.status, "ready", run.error);
    assert.deepEqual(
      [...new Set(phases)],
      ["queued", "form", "answers", "packaging", "ready"],
    );
    assert.deepEqual(f.documentTasks, []);
    assert.deepEqual(f.store.list("application"), []);
    assert.deepEqual(f.store.list("generated_document"), []);
    assert.equal(f.answerTurns.length, 1);
    const script = f.store.get("application_autofill", run.scriptId ?? "");
    assert.ok(script);
    assert.deepEqual(script.attachments, []);
    assert.equal(autofillPreparationView(script, run).incomplete, true);
    const counts = withReadCache(f.store, () =>
      openingAutofillCounts(f.store, f.manager.state()),
    );
    assert.deepEqual(counts, {
      openingAutofillFinishCounts: {},
      openingAutofillAnswerCounts: { one: { scope: "answers", count: 0 } },
    });
    const completed = f.manager.start("one");
    assert.notEqual(completed.id, first.id);
    assert.ok(completed.applicationId);
    const finished = (await f.advance()).run;
    assert.equal(finished.status, "ready", finished.error);
    assert.equal(
      f.answerTurns.length,
      1,
      "unchanged questions start no second answer-drafting turn",
    );
    assert.equal(f.documentTasks.length, 1);
    const final = f.manager.latest("one");
    assert.ok(final?.scriptId);
    const attached = f.store.get("application_autofill", final.scriptId);
    assert.equal(attached?.attachments?.length, 2);
    assert.equal(
      attached?.dynamicQuestions?.[0].answer,
      script.dynamicQuestions?.[0].answer,
    );
    assert.equal(
      f.store.get("application", completed.applicationId)?.status,
      "ready",
    );
    assert.deepEqual(
      openingAutofillCounts(f.store, f.manager.state())
        .openingAutofillFinishCounts,
      { one: 0 },
    );
  } finally {
    await f.close();
  }
});

test("answers-only keeps existing application stages and metadata unchanged and reports real staleness", async () => {
  const f = answersPreparationFixture();
  try {
    const full = f.manager.start("one");
    assert.ok(full.applicationId);
    await f.advance();
    const before = f.store.list("application");
    f.manager.start("one", undefined, "answers");
    const finished = (await f.advance()).run;
    assert.equal(finished.status, "ready", finished.error);
    assert.deepEqual(f.store.list("application"), before);
    assert.equal(f.answerTurns.length, 1);
    atomicWrite(path.join(f.root, source), "Changed factual evidence");
    assert.equal(f.manager.latest("one")?.stale, true);
    assert.deepEqual(
      withReadCache(f.store, () =>
        openingAutofillCounts(f.store, f.manager.state()),
      ).openingAutofillAnswerCounts,
      {},
    );
    assert.match(
      f.manager.latest("one")?.staleReasons?.join(" ") ?? "",
      /Evidence used for written answers changed/,
    );
  } finally {
    await f.close();
  }
});

test("answers-only shares the live queue limit and pauses on restart", async () => {
  const f = answersPreparationFixture();
  try {
    const opening = f.store.opening("one");
    assert.ok(opening);
    f.store.put("cache_opening", "two", { ...opening, id: "two" });
    f.store.put("settings", "main", {
      ...f.store.settings(),
      parallelPreparations: 1,
    });
    const first = f.manager.start("one", undefined, "answers");
    const second = f.manager.start("two");
    assert.equal(f.manager.start("two", undefined, "answers").id, second.id);
    await f.manager.tick();
    assert.equal(f.manager.latest("one")?.phase, "form");
    assert.equal(f.manager.latest("two")?.status, "queued");
    await f.manager.close();
    const restored = new ApplicationPreparationManager(f.store, {
      changed() {},
      generateScript: async () => {
        throw new Error("No restart work expected");
      },
      createDocuments: async () => {
        throw new Error("No restart work expected");
      },
      startTask: async () => undefined,
      startAnswers: async () => null,
    });
    assert.equal(restored.latest("one")?.status, "paused");
    assert.equal(restored.latest("one")?.scope, "answers");
    assert.equal(restored.latest("two")?.status, "paused");
    const retry = restored.start("one", undefined, "answers");
    assert.notEqual(retry.id, first.id);
    assert.equal(retry.scope, "answers");
    await restored.close();
  } finally {
    await f.close();
  }
});

test("prepare route rejects invalid scopes, mixed document requests and unsupported answers-only forms", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "answers-route-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    workspace.store.put(
      "cache_opening",
      "one",
      legacyOpening({ id: "one", url: "https://example.com/job" }),
    );
    for (const body of [
      { scope: "other" },
      { scope: null },
      { scope: "answers", documentKind: "resume" },
    ]) {
      const response = await workspace.post("/api/openings/one/prepare", body);
      assert.equal(response.status, 400);
    }
    const unsupported = await workspace.post("/api/openings/one/prepare", {
      scope: "answers",
    });
    assert.equal(unsupported.status, 409);
    assert.match(
      (await unsupported.json()).error,
      /supported Greenhouse application form/,
    );
    assert.deepEqual(workspace.store.list("application"), []);
    assert.deepEqual(workspace.store.list("application_preparation"), []);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("answers-only reports unsupported inspected forms without creating PDFs or Applications", async () => {
  const f = answersPreparationFixture();
  try {
    f.form.html = "<p>This posting uses an unsupported form.</p>";
    f.manager.start("one", undefined, "answers");
    const { run } = await f.advance();
    assert.equal(run.status, "failed");
    assert.match(run.error ?? "", /no supported Greenhouse application form/);
    assert.deepEqual(f.store.list("application"), []);
    assert.deepEqual(f.documentTasks, []);
    assert.deepEqual(f.answerTurns, []);
  } finally {
    await f.close();
  }
});

test("answers-only profile edits and deleted scripts invalidate ready state without record rewrites", async () => {
  const f = answersPreparationFixture();
  try {
    f.manager.start("one", undefined, "answers");
    const { run } = await f.advance();
    assert.equal(run.stale, false);
    atomicWrite(
      path.join(f.root, ".local/greenhouse/profile.json"),
      JSON.stringify({
        version: 1,
        firstName: "Changed",
        email: "test@example.com",
      }),
    );
    assert.equal(f.manager.latest("one")?.stale, true);
    assert.match(
      f.manager.latest("one")?.staleReasons?.join(" ") ?? "",
      /Saved profile answers changed/,
    );
    assert.equal(
      f.store.get("application_preparation", run.id)?.stale,
      undefined,
    );
    assert.ok(run.scriptId);
    for (const record of f.store.list("application_autofill"))
      f.store.remove("application_autofill", record.id);
    assert.match(
      f.manager.latest("one")?.staleReasons?.join(" ") ?? "",
      /script is missing/,
    );
  } finally {
    await f.close();
  }
});

test("answers-only count excludes generated uploads but retains other uploads and manual questions", async () => {
  const f = answersPreparationFixture();
  try {
    f.form.html = f.form.html.replace(
      "</form>",
      '<label for="portfolio">Portfolio</label><input id="portfolio" type="file"></form>',
    );
    f.manager.start("one", undefined, "answers");
    const { run } = await f.advance();
    assert.equal(run.status, "ready", run.error);
    const record = f.store.get("application_autofill", run.scriptId ?? "");
    assert.ok(record);
    assert.ok(
      record.review.some(
        (item) =>
          item.label === "Portfolio" && item.reason === attachDocumentReason,
      ),
    );
    assert.equal(
      autofillPreparationView(record, run).answersOnlyFinishItems.length,
      2,
    );
    assert.deepEqual(
      withReadCache(f.store, () =>
        openingAutofillCounts(f.store, f.manager.state()),
      ).openingAutofillAnswerCounts,
      { one: { scope: "answers", count: 2 } },
    );
  } finally {
    await f.close();
  }
});
