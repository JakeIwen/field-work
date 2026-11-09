import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store, atomicWrite } from "../../server/storage.js";
import { sampleWorkspaceRoot as repositoryRoot } from "../fixtures/sample-workspace.js";
import { importRepository } from "../../server/importer.js";
import { draftPath, collectArtifacts } from "../../server/bundles.js";
import {
  preparePostingDocumentBundle,
  questionReferenceId,
} from "../../server/question-context.js";
import { renderApplicationDocuments } from "../../server/application-documents.js";
import {
  documentFilename,
  normalizeGeneratedDocument,
} from "../../server/document-names.js";
import { legacyTask, legacyDocument } from "../fixtures/legacy-records.js";

const at = "2026-10-08T05:40:01Z";
test("new tailored filenames omit private while existing filenames keep their naming version", () => {
  const legacyName = documentFilename(
    "Example Engineer",
    "resume",
    "private",
    at,
    "old",
    2,
  );
  const legacy = legacyDocument({
    id: "old",
    origin: "generated",
    name: legacyName,
    postingLabel: "Example Engineer",
    kind: "resume",
    privacy: "private",
    createdAt: at,
    generatedTurnId: "old",
    namingVersion: 2,
  });
  assert.equal(normalizeGeneratedDocument(legacy).name, legacyName);
  assert.match(legacyName, /_private_/);
  const current = {
    ...legacy,
    id: "new",
    namingVersion: 3,
    generatedTurnId: "new",
    name: documentFilename("Example Engineer", "resume", "private", at, "new"),
  };
  assert.doesNotMatch(current.name, /_private_|_public_/);
  assert.equal(normalizeGeneratedDocument(current).name, current.name);
  assert.doesNotMatch(
    documentFilename("Example Engineer", "cover-letter", "private", at, "new"),
    /_private_|_public_/,
  );
});

test(
  "combined Opening generation renders and validates exactly one resume and one cover letter",
  { skip: process.platform !== "darwin" },
  async () => {
    const data = mkdtempSync(
      path.join(os.tmpdir(), "private-application-output-"),
    );
    const store = new Store(repositoryRoot, data);
    try {
      const imported = await importRepository(repositoryRoot);
      for (const doc of imported.documents)
        store.put("cache_document", doc.id, doc);
      const task = legacyTask({
        id: randomUUID(),
        preset: "posting-application",
        status: "completed",
        postingLabel: "Fixture Engineer",
        posting: {
          kind: "pasted",
          text: "A controlled engineering role used only to test document rendering.",
          hash: "fixture-posting",
        },
      });
      const prepared = preparePostingDocumentBundle(store, task, {
        id: questionReferenceId,
        text: "Synthetic rendering test context.",
      });
      assert.equal(prepared.bundle.privateOnly, true);
      assert.ok(
        !prepared.bundle.paths.some((file) =>
          /_public\.(html|pdf)$/.test(file),
        ),
      );
      atomicWrite(
        draftPath(store, task.id, "cover_letter.txt"),
        "Dear hiring team,\n\n" +
          "This is a controlled document-rendering fixture. It checks that the saved application package contains a readable resume and cover letter with consistent contact details and complete selectable text. ".repeat(
            3,
          ) +
          "\n\nThank you,\nSam Rivera",
      );
      store.put("task", task.id, {
        ...task,
        bundle: prepared.bundle,
        manifest: prepared.manifest,
      });
      const result = await renderApplicationDocuments(
        store,
        task.id,
        "private-only-turn",
      );
      assert.equal(result.status, "ready", result.error);
      const documents = store.list("generated_document");
      assert.deepEqual(documents.map((doc) => doc.kind).sort(), [
        "cover-letter",
        "resume",
      ]);
      for (const doc of documents) {
        assert.equal(doc.privacy, "private");
        assert.equal(doc.namingVersion, 3);
        assert.equal(doc.validation, "passed");
        assert.match(doc.writingRuleHash ?? "", /^[a-f0-9]{64}$/);
        assert.doesNotMatch(doc.name, /_public_|_private_/);
        assert.equal(
          readFileSync(store.objectPath(doc.hash)).subarray(0, 5).toString(),
          "%PDF-",
        );
      }
      assert.ok(
        !collectArtifacts(store, task.id).some((file) =>
          /_public\.(html|pdf)$/.test(file.path),
        ),
      );
      assert.equal(result.documentIds?.length, 2);
    } finally {
      store.close();
      rmSync(data, { recursive: true, force: true });
    }
  },
);
