import { clientTaskSummaries } from "../server/client-task-summary.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Records } from "../server/records.js";
import { atomicWrite } from "../server/storage.js";
import { withReadCache } from "../server/storage-read-cache.js";
import {
  savedAutofills,
  savedAutofillHistory,
} from "../server/autofill/validity.js";
import { generateAutofill } from "../server/greenhouse-autofill.js";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { legacyTask } from "./fixtures/legacy-records.js";

test("latest autofill reads one version; history returns only metadata", async (t) => {
  const f = applicationAnswerFixture();
  try {
    const first = await generateAutofill(f.store, "one", f.read);
    for (let version = 2; version <= 20; version++)
      f.store.put("application_autofill", `script-${version}`, {
        ...first,
        id: `script-${version}`,
        version,
      });
    const original = f.store.list("application_autofill");
    const counts = new Map<string, number>();
    const list = f.store.list.bind(f.store);
    t.mock.method(f.store, "list", (kind: keyof Records) => {
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      assert.notEqual(
        kind,
        "task",
        "Never copy complete task histories to check script validity",
      );
      return list(kind);
    });
    const current = savedAutofills(f.store, "one", true);
    assert.equal(current.length, 1);
    assert.equal(current[0].version, 20);
    // Openings may already be cached across requests; never once per version.
    assert.ok((counts.get("cache_opening") ?? 0) <= 1);
    const history = savedAutofillHistory(f.store, "one");
    assert.equal(history.length, 20);
    assert.deepEqual(Object.keys(history[0]).sort(), [
      "createdAt",
      "id",
      "version",
    ]);
    const all = savedAutofills(f.store, "one");
    assert.deepEqual(all[0], current[0]);
    assert.equal(all.length, 20);
    assert.deepEqual(f.store.list("application_autofill"), original);
    const profilePath = path.join(f.root, ".local/greenhouse/profile.json");
    const profile = JSON.parse(readFileSync(profilePath, "utf8"));
    atomicWrite(
      profilePath,
      JSON.stringify({ ...profile, firstName: "Changed" }),
    );
    assert.ok(
      savedAutofills(f.store, "one", true)[0].staleReasons.includes(
        "Saved profile answers changed.",
      ),
    );
    f.store.remove("application_autofill", "script-20");
    assert.equal(savedAutofills(f.store, "one", true)[0].version, 19);
  } finally {
    f.cleanup();
  }
});

test("Opening projections stay fresh after edits, rollback and errors", (t) => {
  const f = applicationAnswerFixture();
  try {
    const original = f.store.opening("one");
    assert.ok(original);
    let rebuilds = 0;
    const list = f.store.list.bind(f.store);
    t.mock.method(f.store, "list", (kind: keyof Records) => {
      if (kind === "cache_opening") rebuilds++;
      return list(kind);
    });
    withReadCache(f.store, () => {
      for (let i = 0; i < 100; i++)
        assert.equal(f.store.opening("one")?.hash, original.hash);
      // The first read above built the projection; it survives until an Opening record changes.
      assert.equal(rebuilds, 0);
      f.store.put("cache_opening", "one", { ...original, hash: "edited" });
      for (let i = 0; i < 100; i++)
        assert.equal(f.store.opening("one")?.hash, "edited");
      assert.equal(rebuilds, 1);
      assert.throws(() =>
        f.store.transaction(() => {
          f.store.put("cache_opening", "one", {
            ...original,
            hash: "rollback",
          });
          assert.equal(f.store.opening("one")?.hash, "rollback");
          throw Error("rollback");
        }),
      );
      assert.equal(f.store.opening("one")?.hash, "edited");
    });
    assert.throws(() =>
      withReadCache(f.store, () => {
        f.store.opening("one");
        throw Error("read failed");
      }),
    );
    f.store.put("cache_opening", "one", { ...original, hash: "later" });
    assert.equal(
      withReadCache(f.store, () => f.store.opening("one"))?.hash,
      "later",
    );
  } finally {
    f.cleanup();
  }
});

test("Opening status queries exclude unrelated tasks and preserve ordering", () => {
  const f = applicationAnswerFixture();
  try {
    f.store.put(
      "task",
      "other",
      legacyTask({ id: "other", context: { openingId: "two" } }),
    );
    f.store.put(
      "task",
      "same",
      legacyTask({ id: "same", context: { openingId: "one" } }),
    );
    assert.deepEqual(
      f.store.taskSummaries(undefined, "one").map((t) => t.id),
      [f.task.id, "same"],
    );
  } finally {
    f.cleanup();
  }
});

test("page summaries keep review identity while decisions, drafts and instructions stay stored", () => {
  const f = applicationAnswerFixture();
  try {
    const review = legacyTask({
      id: "review",
      preset: "opening-research",
      greenhousePull: {
        runId: "run",
        candidateId: "candidate",
        instructions: "Review rules. ".repeat(1000),
      },
      greenhouseDecision: { decision: "excluded", reason: "Out of scope" },
      researchResult: { title: "Engineer" },
      documentRuns: { resume: { status: "ready" } },
    });
    const answers = legacyTask({
      id: "answers",
      autofillDraft: { answers: [] },
    });
    f.store.put("task", review.id, review);
    f.store.put("task", answers.id, answers);
    const sent = JSON.parse(
      JSON.stringify(clientTaskSummaries(f.store.taskSummaries())),
    ) as Record<string, unknown>[];
    const byId = new Map(sent.map((task) => [task.id, task]));
    assert.deepEqual(byId.get("review")?.greenhousePull, {
      runId: "run",
      candidateId: "candidate",
    });
    for (const task of sent)
      for (const field of [
        "researchResult",
        "greenhouseDecision",
        "autofillDraft",
        "documentRuns",
      ])
        assert.equal(field in task, false, `${field} left the server`);
    const stored = f.store.get("task", "review");
    assert.equal(
      stored?.preset === "opening-research" &&
        stored.greenhouseDecision?.reason,
      "Out of scope",
    );
    assert.equal(
      stored?.preset === "opening-research" &&
        stored.greenhousePull?.instructions?.length,
      14000,
    );
  } finally {
    f.cleanup();
  }
});

test("page summaries omit duplicated posting bodies while task detail and provenance retain them", () => {
  const f = applicationAnswerFixture();
  try {
    const task = legacyTask({
      id: "body",
      posting: {
        url: "https://example.com/job",
        text: "Captured employer text".repeat(10000),
        hash: "evidence",
      },
    });
    f.store.put("task", task.id, task);
    const full = f.store.taskSummaries(task.id);
    const page = clientTaskSummaries(full)[0];
    assert.equal(page.posting?.text, undefined);
    assert.equal(page.posting?.url, task.posting?.url);
    assert.equal(page.posting?.hash, "evidence");
    assert.equal(
      f.store.get("task", task.id)?.posting?.text,
      task.posting?.text,
    );
    assert.equal(full[0].posting?.text, task.posting?.text);
    assert.ok(
      JSON.stringify(page).length < JSON.stringify(full[0]).length / 10,
    );
  } finally {
    f.cleanup();
  }
});
