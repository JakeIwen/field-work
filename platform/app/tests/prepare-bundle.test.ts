import { sampleWorkspaceRoot as repositoryRoot } from "./fixtures/sample-workspace.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store, sha256 } from "../server/storage.js";
import { importRepository } from "../server/importer.js";
import { prepareBundle } from "../server/bundles.js";
import { promoteBundle } from "../server/promotion.js";
import { legacyTask } from "./fixtures/legacy-records.js";

async function fixture(fn: (store: Store, documents: any[]) => Promise<void>) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "job-search-prepare-"));
  const store = new Store(repositoryRoot, dataDir);
  try {
    const imported = await importRepository(repositoryRoot);
    for (const doc of imported.documents)
      store.put("cache_document", doc.id, doc);
    await fn(store, imported.documents);
  } finally {
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("sample tailored selection targets its separate master and exactly its two resume PDFs", async () =>
  fixture(async (store, documents) => {
    const resume = documents.find(
      (d) => d.path === "employer_specific/northwind/resume_private.pdf",
    )!;
    const letter = documents.find(
      (d) => d.path === "employer_specific/northwind/cover_letter_private.pdf",
    )!;
    const id = randomUUID(),
      task = {
        id,
        preset: "resume-revision",
        context: { documentIds: [resume.id, letter.id] },
      };
    const general = "source_data/resume.md";
    const originalHash = sha256(await readFile(path.join(store.root, general)));
    const prepared = prepareBundle(store, task);
    store.put(
      "task",
      id,
      legacyTask({
        id,
        preset: "resume-revision",
        context: task.context,
        bundle: prepared.bundle,
      }),
    );
    assert.equal(prepared.bundle.scope, "tailored");
    assert.equal(
      prepared.bundle.master,
      "employer_specific/northwind/resume.md",
    );
    assert.equal(prepared.bundle.versionDir, "employer_specific/northwind");
    const targetPaths = prepared.bundle.paths.filter((p) =>
      p.startsWith("employer_specific/northwind/"),
    );
    assert.equal(targetPaths.filter((p) => p.endsWith(".pdf")).length, 2);
    assert.deepEqual(targetPaths.filter((p) => p.endsWith(".html")).sort(), [
      "employer_specific/northwind/resume.html",
      "employer_specific/northwind/resume_public.html",
    ]);
    assert.equal(
      targetPaths.some((p) => /cover_letter|Cover_Letter/.test(p)),
      false,
    );
    assert.equal(prepared.manifest.excludedDocuments[0].id, letter.id);
    assert.ok(
      prepared.bundle.paths.includes("source_data/github_evidence_dossier.md"),
    );
    assert.ok(prepared.bundle.paths.includes(general));
    assert.match(
      await readFile(path.join(prepared.cwd, "AGENTS.md"), "utf8"),
      /general master.*read-only reference context/,
    );
    assert.equal(
      sha256(await readFile(path.join(store.root, general))),
      originalHash,
    );
    assert.equal(
      await readFile(path.join(prepared.cwd, prepared.bundle.master), "utf8"),
      await readFile(path.join(store.root, prepared.bundle.master), "utf8"),
    );
    assert.throws(
      () => promoteBundle(store, id),
      /employer-specific resume bundle.*General-master promotion is unavailable/,
    );
  }));

test("missing tailored private/public variants refuse preparation before copying files", async () =>
  fixture(async (store, documents) => {
    const selected = documents.find(
      (d) => d.path === "employer_specific/northwind/resume.md",
    )!;
    const publicHtml = documents.find(
      (d) => d.path === "employer_specific/northwind/resume_public.html",
    )!;
    store.db
      .prepare("DELETE FROM records WHERE kind=? AND id=?")
      .run("cache_document", publicHtml.id);
    assert.throws(
      () =>
        prepareBundle(store, {
          id: randomUUID(),
          preset: "resume-revision",
          context: { documentIds: [selected.id] },
        }),
      /one unambiguous public HTML variant/,
    );
  }));

test("historical tailored selections cannot silently select the general master", async () =>
  fixture(async (store, documents) => {
    const selected = documents.find(
      (d) =>
        d.scope === "tailored" &&
        d.kind === "resume" &&
        d.path.includes("/revisions/"),
    )!;
    assert.throws(
      () =>
        prepareBundle(store, {
          id: randomUUID(),
          preset: "resume-revision",
          context: { documentIds: [selected.id] },
        }),
      /Select a current employer-specific resume/,
    );
  }));

test("general resume tasks retain the current general master and version directory", async () =>
  fixture(async (store, documents) => {
    const selected = documents.find(
      (d) =>
        d.scope === "general" &&
        d.status === "current" &&
        d.format === "pdf" &&
        d.privacy === "private",
    )!;
    const prepared = prepareBundle(store, {
      id: randomUUID(),
      preset: "resume-revision",
      context: { documentIds: [selected.id] },
    });
    assert.equal(prepared.bundle.scope, "general");
    assert.equal(prepared.bundle.master, "source_data/resume.md");
    assert.equal(prepared.bundle.versionDir, path.posix.dirname(selected.path));
    assert.equal(prepared.manifest.excludedDocuments.length, 0);
  }));
