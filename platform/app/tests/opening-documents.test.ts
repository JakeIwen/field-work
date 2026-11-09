import test from "node:test";
import assert from "node:assert/strict";
import {
  openingGenerationCounts,
  openingDocumentTaskBusy,
} from "../shared/opening-documents.js";

test("counts successful Generate Docs runs per opening, including successes before a failed retry", () => {
  const run = (id: string, status: string, openingId = "one") => ({
    id,
    status,
    openingId,
  });
  assert.deepEqual(
    openingGenerationCounts([
      run("success-1", "ready"),
      run("success-2", "ready"),
      run("success-2", "ready"),
      run("queued", "queued"),
      run("running", "running"),
      run("failed", "failed"),
      run("waiting", "waiting"),
      run("paused", "paused"),
      run("other-success", "ready", "two"),
      run("unfinished", "running", "three"),
    ]),
    { one: 2, two: 1 },
  );
  assert.deepEqual(openingGenerationCounts([]), {});
});

test("validated documents count even when later answers or script packaging fail", () => {
  const completedDocs = {
    id: "mindbody-run",
    openingId: "mindbody",
    phase: "packaging",
    documentIds: ["resume", "cover"],
  };
  for (const status of ["running", "failed", "paused", "waiting"]) {
    assert.deepEqual(
      openingGenerationCounts([
        { ...completedDocs, status },
        { ...completedDocs, status },
      ]),
      { mindbody: 1 },
    );
  }
  assert.deepEqual(
    openingGenerationCounts([
      { ...completedDocs, status: "failed", phase: "documents" },
    ]),
    {},
  );
  assert.deepEqual(
    openingGenerationCounts([
      { ...completedDocs, status: "failed", documentIds: ["resume"] },
    ]),
    {},
  );
  assert.deepEqual(
    openingGenerationCounts([
      { ...completedDocs, status: "failed", documentIds: ["resume", "resume"] },
    ]),
    {},
  );
});

test("busy tracking covers document and answer tasks, PDF rendering, and answer saving per opening", () => {
  const task = {
    context: { openingId: "one" },
    preset: "posting-application",
    status: "running",
  };
  assert.equal(openingDocumentTaskBusy("one", [task]), true);
  assert.equal(openingDocumentTaskBusy("two", [task]), false);
  for (const status of ["queued", "waiting for input", "waiting for approval"])
    assert.equal(openingDocumentTaskBusy("one", [{ ...task, status }]), true);
  assert.equal(
    openingDocumentTaskBusy("one", [
      { ...task, status: "completed", documentResult: { status: "rendering" } },
    ]),
    true,
  );
  assert.equal(
    openingDocumentTaskBusy("one", [
      {
        ...task,
        preset: "questions",
        autofillContext: {},
        status: "completed",
        autofillResult: { status: "saving" },
      },
    ]),
    true,
  );
  assert.equal(
    openingDocumentTaskBusy("one", [{ ...task, status: "completed" }]),
    false,
  );
  assert.equal(
    openingDocumentTaskBusy("one", [{ ...task, status: "failed" }]),
    false,
  );
  assert.equal(
    openingDocumentTaskBusy("one", [{ ...task, preset: "questions" }]),
    false,
  );
});
