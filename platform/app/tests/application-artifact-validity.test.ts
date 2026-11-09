import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { atomicWrite, sha256 } from "../server/storage.js";
import {
  answerKnowledgeHash,
  publishApplicationAnswers,
  stageApplicationAnswers,
} from "../server/application-answers.js";
import {
  generateAutofill,
  savedAutofills,
  savedAutofillScript,
} from "../server/greenhouse-autofill.js";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import {
  startAutofillAnswers,
  type AutofillAnswerServices,
} from "../server/task-kinds/autofill-answers.js";

function legacyFixture() {
  const f = applicationAnswerFixture();
  const entries = f.task.manifest.paths.map((p) => [
    p,
    sha256(readFileSync(path.join(f.root, p))),
  ]);
  const sourceHashes = Object.fromEntries(entries);
  const legacyHash = sha256(JSON.stringify(entries));
  const task = f.store.get("task", f.task.id);
  assert.ok(task?.manifest && task.autofillContext);
  f.store.put("task", task.id, {
    ...task,
    manifest: { ...task.manifest, sourceHashes },
    autofillContext: { ...task.autofillContext, knowledgeHash: legacyHash },
  });
  return { ...f, legacyHash };
}

test("legacy answers and scripts survive app changes without rewriting saved output", async () => {
  const f = legacyFixture();
  try {
    f.payload.answers[0].manualReviewRequired = false;
    f.payload.answers[0].reviewReason = "";
    const task = f.store.get("task", f.task.id);
    assert.ok(task);
    stageApplicationAnswers(f.store, task, f.payload);
    const staged = f.store.get("task", task.id);
    assert.ok(staged);
    f.store.put("task", task.id, { ...staged, status: "completed" });
    publishApplicationAnswers(f.store, task.id, "turn");
    const generated = await generateAutofill(f.store, "one", f.read);
    f.store.put("application_autofill", generated.id, {
      ...generated,
      knowledgeHash: f.legacyHash,
      helperHash: "old-helper",
    });
    const original = savedAutofillScript(f.store, "one", generated.id).script;
    const stableHash = answerKnowledgeHash(f.store);
    for (const p of [
      "AGENTS.md",
      "source_data/README.md",
      "platform/app/client/App.tsx",
      "platform/app/client/styles.css",
      "platform/dist/index.html",
    ])
      atomicWrite(path.join(f.root, p), "New development and app instructions");
    assert.equal(answerKnowledgeHash(f.store), stableHash);
    assert.equal(savedAutofills(f.store, "one")[0].stale, false);
    const reused = await generateAutofill(f.store, "one", f.read);
    assert.equal(reused.dynamicQuestions?.[0].taskId, task.id);
    assert.equal(
      reused.dynamicQuestions?.[0].answer,
      f.payload.answers[0].answer,
    );
    assert.equal(
      savedAutofillScript(f.store, "one", generated.id).script,
      original,
    );
    assert.equal(
      f.store.get("application_autofill", generated.id)?.knowledgeHash,
      f.legacyHash,
    );
    atomicWrite(
      path.join(f.root, "source_data/github_evidence_dossier.md"),
      "Corrected factual evidence",
    );
    assert.equal(
      savedAutofills(f.store, "one").find((r) => r.id === generated.id)?.stale,
      true,
    );
    assert.ok(
      savedAutofills(f.store, "one")
        .find((r) => r.id === generated.id)
        ?.staleReasons.includes("Evidence used for written answers changed."),
    );
    const changed = await generateAutofill(f.store, "one", f.read);
    assert.equal(changed.dynamicQuestions?.[0].answer, undefined);
  } finally {
    f.cleanup();
  }
});

test("legacy in-flight drafts can finish after app instructions change", () => {
  const f = legacyFixture();
  try {
    const task = f.store.get("task", f.task.id);
    assert.ok(task);
    stageApplicationAnswers(f.store, task, f.payload);
    const staged = f.store.get("task", task.id);
    assert.ok(staged);
    f.store.put("task", task.id, { ...staged, status: "completed" });
    atomicWrite(path.join(f.root, "AGENTS.md"), "Updated app instructions");
    assert.equal(
      publishApplicationAnswers(f.store, task.id, "turn").answers.length,
      1,
    );
    atomicWrite(
      path.join(f.root, "source_data/github_evidence_dossier.md"),
      "Corrected facts",
    );
    assert.throws(
      () => publishApplicationAnswers(f.store, task.id, "turn"),
      /evidence changed/,
    );
  } finally {
    f.cleanup();
  }
});

test("legacy scripts can start unanswered questions using current evidence after an app update", async () => {
  const f = legacyFixture();
  try {
    const generated = await generateAutofill(f.store, "one", f.read);
    const legacy = { ...generated, knowledgeHash: f.legacyHash };
    atomicWrite(path.join(f.root, "AGENTS.md"), "Updated app instructions");
    let capturedHash: string | undefined;
    const services: AutofillAnswerServices = {
      store: f.store,
      taskActive: () => false,
      createTask: async (_body, options) => {
        capturedHash = options?.autofillContext?.knowledgeHash;
        return undefined;
      },
    };
    await startAutofillAnswers(services, legacy);
    assert.equal(capturedHash, answerKnowledgeHash(f.store));
    atomicWrite(
      path.join(f.root, "source_data/github_evidence_dossier.md"),
      "Corrected facts",
    );
    await assert.rejects(
      () => startAutofillAnswers(services, legacy),
      /evidence changed/,
    );
  } finally {
    f.cleanup();
  }
});
