import { collectArtifacts } from "../server/bundles.js";
import { createBackupArchive } from "../server/backup-archive.js";
import { verifyBackup } from "../server/backup-verify.js";
import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
  rename,
  symlink,
} from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { Store, sha256 } from "../server/storage.js";
import { promoteBundle } from "../server/promotion.js";

const MASTER = "source_data/resume.md";
const EVIDENCE = "source_data/github_evidence_dossier.md";
const SOURCE_README = "source_data/README.md";
const oldDir = "source_master_template/v10";
// Promotion tests exercise the transaction and validation gate using explicit
// validation fixtures. The separate release workflow runs real HTML/PDF validators.
async function fixture(
  fn: (
    root: string,
    store: Store,
    id: string,
    originals: Record<string, string>,
  ) => Promise<void>,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "job-search-promotion-")),
    id = randomUUID(),
    dataDir = path.join(root, ".data");
  await mkdir(path.join(root, "source_data"), { recursive: true });
  await mkdir(path.join(root, oldDir), { recursive: true });
  const store = new Store(root, dataDir);
  const draftRoot = path.join(dataDir, "drafts", id);
  const originals: Record<string, string> = {
    "AGENTS.md":
      "Preserve earlier resume versions and use the evidence dossier.",
    "README.md":
      "[Version 10](source_master_template/v10/) is current.\nsource_master_template/v10/resume_2026_design_source_v10.html\nsource_master_template/v10/resume_2026_design_source_v10_public.html\n",
    [MASTER]: "# Resume\nOriginal facts\n",
    [EVIDENCE]: "# Evidence\nOriginal evidence\n",
    [SOURCE_README]:
      "- `resume.md` — current general content master, synchronized to `source_master_template/v10/` on September 5, 2026.\n\nPreserved v9 is historical.\nsource_master_template/v10/resume_2026_design_source_v10.html\n",
    [`${oldDir}/resume_2026_design_source_v10.html`]:
      "<p>Original facts 202-555-0142</p>",
    [`${oldDir}/resume_2026_design_source_v10_public.html`]:
      "<p>Original facts</p>",
    [`${oldDir}/resume_private.pdf`]: "%PDF fixture original private",
    [`${oldDir}/resume_public.pdf`]: "%PDF fixture original public",
    [`${oldDir}/resume.md`]: "# Resume\nOriginal facts\n",
    [`${oldDir}/revision_notes.md`]:
      "# Existing notes\nReviewed September 5, 2026.\n",
    [`${oldDir}/verify_pdfs.swift`]:
      "// use source_master_template/v10/ and filename _v10.pdf\n",
  };
  const sourceHashes: Record<string, string> = {},
    artifacts: any[] = [];
  for (const [relative, content] of Object.entries(originals)) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
    sourceHashes[relative] = sha256(content);
    let draft = content;
    if (relative === MASTER) draft = "# Resume\nRevised facts\n";
    if (relative === EVIDENCE)
      draft =
        "# Evidence\nOriginal evidence\nRevision rationale and source evidence.\n";
    if (relative.endsWith(".html"))
      draft = content.replace("Original facts", "Revised facts");
    if (relative.endsWith(".pdf"))
      draft = content.replace("original", "revised");
    await mkdir(path.dirname(path.join(draftRoot, relative)), {
      recursive: true,
    });
    await writeFile(path.join(draftRoot, relative), draft);
    if (!relative.endsWith(".swift"))
      artifacts.push({
        path: relative,
        hash: sha256(draft),
        format: path.extname(relative).slice(1),
      });
  }
  store.put(
    "task",
    id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
    { id, preset: "resume-revision", status: "completed" } as Records["task"],
  );
  store.put(
    "bundle",
    id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
    {
      id,
      status: "validated",
      version: 2,
      versionDir: oldDir,
      sourceHashes,
      artifacts,
      validation: {
        status: "passed",
        at: "2026-09-06T12:00:00Z",
        checks: [
          { name: "Original source hashes", status: "passed" },
          { name: "Markdown and private/public HTML", status: "passed" },
          { name: "PDF page count and selectable text", status: "passed" },
          { name: "Evidence accompanies content revision", status: "passed" },
        ],
      },
    } as Records["bundle"],
  );
  try {
    await fn(root, store, id, originals);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("promotion backups require captured artifacts and rollback bytes, not source-output fingerprints", async () =>
  fixture(async (_root, store, id, originals) => {
    const bundle = store.get("bundle", id);
    assert.ok(bundle);
    store.put("bundle", id, {
      ...bundle,
      artifacts: collectArtifacts(store, id),
    });
    promoteBundle(store, id);
    const backup = createBackupArchive(store);
    assert.equal(backup.integrity.ok, true, JSON.stringify(backup.integrity));
    assert.equal(verifyBackup(backup.bytes).ok, true);
    const rollbackHash = sha256(originals[MASTER]);
    await rm(store.objectPath(rollbackHash));
    const partial = createBackupArchive(store);
    assert.deepEqual(partial.integrity.missingObjects, [rollbackHash]);
    assert.deepEqual(verifyBackup(partial.bytes).missingObjects, [
      rollbackHash,
    ]);
  }));

test("explicit promotion creates next numeric version, preserves history and synchronizes authority references", async () =>
  fixture(async (root, store, id, originals) => {
    await mkdir(path.join(root, "source_master_template/v11_bad")); // Numeric ordering must not overwrite this existing directory.
    const promoted = promoteBundle(store, id);
    assert.equal(promoted.version, "v12");
    for (const [relative, content] of Object.entries(originals))
      if (relative.startsWith(oldDir + "/"))
        assert.equal(
          await readFile(path.join(root, relative), "utf8"),
          content,
        );
    const master = await readFile(path.join(root, MASTER), "utf8");
    assert.match(master, /Revised facts/);
    assert.equal(
      await readFile(
        path.join(root, "source_master_template/v12/resume.md"),
        "utf8",
      ),
      master,
    );
    assert.match(
      await readFile(path.join(root, SOURCE_README), "utf8"),
      /source_master_template\/v12\//,
    );
    assert.match(
      await readFile(path.join(root, "README.md"), "utf8"),
      /\[Version 12\]/,
    );
    assert.match(
      await readFile(path.join(root, EVIDENCE), "utf8"),
      /Revision rationale/,
    );
    assert.equal(
      await readFile(
        path.join(root, "source_master_template/v12/resume_v12_public.pdf"),
        "utf8",
      ),
      "%PDF fixture revised public",
    );
    assert.match(
      await readFile(
        path.join(root, "source_master_template/v12/verify_pdfs.swift"),
        "utf8",
      ),
      /v12/,
    );
    assert.doesNotMatch(
      await readFile(
        path.join(root, "source_master_template/v12/verify_pdfs.swift"),
        "utf8",
      ),
      /v10/,
    );
    assert.equal(store.get("bundle", id)!.status, "promoted");
    assert.equal(store.get("bundle", id)!.promotion!.status, "completed");
    assert.ok(store.state().journal.some((e) => e.type === "resume_promoted"));
    const manifest = JSON.parse(
      await readFile(
        path.join(root, "source_master_template/v12/promotion-manifest.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.status, "completed");
    assert.equal(manifest.sourceHashes[MASTER], sha256(originals[MASTER]));
    assert.throws(() => promoteBundle(store, id), /already promoted/);
    assert.equal(
      (await readdir(path.join(root, "source_master_template"))).includes(
        ".promotion.lock",
      ),
      false,
    );
  }));

test("an original source edited after task creation prevents promotion without overwriting the edit", async () =>
  fixture(async (root, store, id) => {
    await writeFile(path.join(root, MASTER), "External source edit");
    assert.throws(() => promoteBundle(store, id), /External edit detected/);
    assert.equal(
      await readFile(path.join(root, MASTER), "utf8"),
      "External source edit",
    );
    assert.equal(
      (await readdir(path.join(root, "source_master_template"))).includes(
        "v11",
      ),
      false,
    );
  }));

test("a changed draft artifact invalidates prior passed validation", async () =>
  fixture(async (root, store, id, originals) => {
    await writeFile(
      path.join(store.dataDir, "drafts", id, MASTER),
      "Changed after validation",
    );
    assert.throws(() => promoteBundle(store, id), /changed since validation/);
    assert.equal(
      await readFile(path.join(root, MASTER), "utf8"),
      originals[MASTER],
    );
  }));

test("failed validation and missing source baseline are rejected explicitly", async () =>
  fixture(async (_root, store, id) => {
    const original = store.get("bundle", id)!;
    store.put(
      "bundle",
      id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      {
        ...original,
        validation: { ...original.validation, status: "failed" },
      } as Records["bundle"],
    );
    assert.throws(
      () => promoteBundle(store, id),
      /validation checks must pass/,
    );
    const sourceHashes = { ...original.sourceHashes };
    delete sourceHashes["README.md"];
    store.put(
      "bundle",
      id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      { ...original, sourceHashes } as Records["bundle"],
    );
    assert.throws(
      () => promoteBundle(store, id),
      /no original hash for README.md/,
    );
  }));

test("an existing checkout promotion lock serializes app-managed writes", async () =>
  fixture(async (root, store, id, originals) => {
    await writeFile(
      path.join(root, "source_master_template/.promotion.lock"),
      "Existing live promotion",
    );
    assert.throws(() => promoteBundle(store, id), /Another promotion holds/);
    assert.equal(
      await readFile(path.join(root, MASTER), "utf8"),
      originals[MASTER],
    );
    assert.equal(
      await readFile(
        path.join(root, "source_master_template/.promotion.lock"),
        "utf8",
      ),
      "Existing live promotion",
    );
  }));

test("a whole bundle root symlink cannot supply promoted artifacts", async () =>
  fixture(async (root, store, id, originals) => {
    const bundleRoot = path.join(store.dataDir, "drafts", id),
      external = path.join(root, "outside-draft");
    await rename(bundleRoot, external);
    await symlink(external, bundleRoot);
    assert.throws(
      () => promoteBundle(store, id),
      /Draft root must be a real directory/,
    );
    assert.equal(
      await readFile(path.join(root, MASTER), "utf8"),
      originals[MASTER],
    );
  }));

test("an unexpected target preparation failure preserves original masters and a recovery manifest", async () =>
  fixture(async (root, store, id, originals) => {
    const sourceReadme =
      "This fixture deliberately lacks the current version path.";
    await writeFile(path.join(root, SOURCE_README), sourceReadme);
    const bundle = store.get("bundle", id)!;
    bundle.sourceHashes[SOURCE_README] = sha256(sourceReadme);
    store.put(
      "bundle",
      id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      bundle as Records["bundle"],
    );
    assert.throws(
      () => promoteBundle(store, id),
      /reference could not be updated/,
    );
    assert.equal(
      await readFile(path.join(root, MASTER), "utf8"),
      originals[MASTER],
    );
    const transactions = await readdir(path.join(store.dataDir, "promotions"));
    assert.equal(transactions.length, 1);
    const manifest = JSON.parse(
      await readFile(
        path.join(store.dataDir, "promotions", transactions[0]),
        "utf8",
      ),
    );
    assert.equal(manifest.status, "failed");
    assert.deepEqual(manifest.rollbackConflicts, []);
  }));

test("a record-write failure after source updates restores original bytes and releases the lock", async () =>
  fixture(async (root, store, id, originals) => {
    const bundleBefore = store.get("bundle", id);
    const taskBefore = store.get("task", id);
    const originalPut = store.put.bind(store);
    const failure = new Error("Injected promoted bundle record failure");
    const updated = [MASTER, EVIDENCE, SOURCE_README, "README.md"];
    let reachedPostWrite = false;
    store.put = (kind, key, value) => {
      if (kind === "bundle") {
        for (const relative of updated)
          assert.notEqual(
            readFileSync(path.join(root, relative), "utf8"),
            originals[relative],
            `${relative} was written before the injected failure`,
          );
        reachedPostWrite = true;
        throw failure;
      }
      return originalPut(kind, key, value);
    };
    assert.throws(
      () => promoteBundle(store, id),
      (error) => error === failure,
    );
    assert.equal(reachedPostWrite, true);
    for (const relative of updated)
      assert.equal(
        await readFile(path.join(root, relative), "utf8"),
        originals[relative],
        `${relative} was restored by rollback`,
      );
    assert.equal(
      (await readdir(path.join(root, "source_master_template"))).includes(
        ".promotion.lock",
      ),
      false,
    );
    assert.deepEqual(store.get("bundle", id), bundleBefore);
    assert.deepEqual(store.get("task", id), taskBefore);
    const transactions = await readdir(path.join(store.dataDir, "promotions"));
    assert.equal(transactions.length, 1);
    const manifest = JSON.parse(
      await readFile(
        path.join(store.dataDir, "promotions", transactions[0]),
        "utf8",
      ),
    );
    assert.equal(manifest.status, "failed");
    assert.deepEqual(manifest.rollbackConflicts, []);
    assert.equal(manifest.error, String(failure));
  }));
