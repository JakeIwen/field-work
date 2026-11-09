import assert from "node:assert/strict";
import { atomicWrite, now, sha256 } from "../../server/storage.js";
import { generateAutofill } from "../../server/greenhouse-autofill.js";
import {
  stageApplicationAnswers,
  publishApplicationAnswers,
  reviewApplicationAnswer,
} from "../../server/application-answers.js";
import { recordAutofillCopy } from "../../server/autofill/copy.js";
import { materialAnswerFixture, saveMaterialPdfs } from "./material-records.js";
import { legacyApplication } from "./legacy-records.js";

export async function backupMaterialFixture() {
  const f = materialAnswerFixture();
  const ids = saveMaterialPdfs(f.store, "original", f.api);
  stageApplicationAnswers(f.store, f.task, f.payload);
  const task = f.store.get("task", "task");
  assert.ok(task);
  f.store.put("task", task.id, {
    ...task,
    status: "completed",
    activeTurnId: null,
  });
  publishApplicationAnswers(f.store, task.id, "turn");
  const draft = await generateAutofill(f.store, "one", f.read, {
    documentIds: ids,
  });
  const question = draft.dynamicQuestions?.[0];
  assert.ok(question);
  reviewApplicationAnswer(f.store, "one", task.id, question.key, {
    answer: "User-reviewed synthetic answer",
    answerHash: question.answerHash,
    scriptId: draft.id,
  });
  const script = await generateAutofill(f.store, "one", f.read, {
    documentIds: ids,
    preparationId: "preparation",
  });
  f.store.put(
    "application",
    "application",
    legacyApplication({
      id: "application",
      openingId: "one",
      status: "ready",
      documentIds: ids,
      packages: [],
    }),
  );
  f.store.put("application_preparation", "preparation", {
    id: "preparation",
    openingId: "one",
    applicationId: "application",
    status: "ready",
    phase: "ready",
    message: "Ready",
    createdAt: now(),
    updatedAt: now(),
    openingHash: script.openingHash,
    documentIds: ids,
    taskIds: ["documents-original"],
    scriptId: script.id,
    supportedForm: true,
  });
  const application = recordAutofillCopy(f.store, "one", script.id);
  const evidence = JSON.stringify({ status: 200, posting: "Synthetic role" });
  const evidenceHash = sha256(evidence);
  atomicWrite(f.store.objectPath(evidenceHash), evidence);
  f.store.put("opening_validation_run", "validation", {
    id: "validation",
    status: "completed",
    startedAt: now(),
    total: 1,
    completed: 1,
    counts: { open: 1, closed: 0, unknown: 0 },
    targets: [{ id: "one", url: "https://example.com/role" }],
    results: [
      {
        id: "one",
        url: "https://example.com/role",
        status: "open",
        checkedAt: now(),
        reason: "Synthetic posting evidence",
        evidenceHashes: [evidenceHash],
        runId: "validation",
      },
    ],
  });
  return { ...f, ids, script, application };
}
