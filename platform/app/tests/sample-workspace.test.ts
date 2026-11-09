import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { currentResumePath } from "../server/application-evidence.js";
import { importRepository } from "../server/importer.js";
import { currentVersion } from "../server/import/document-content.js";
import { writeSyntheticRoot } from "../scripts/dev-options.js";
import {
  copySampleWorkspace,
  sampleWorkspaceRoot,
} from "./fixtures/sample-workspace.js";

test("sample copies isolate edits and import complete current and historical sources", async (t) => {
  const root = copySampleWorkspace(t);
  const original = readFileSync(
    path.join(sampleWorkspaceRoot, currentResumePath),
    "utf8",
  );
  assert.equal(
    currentVersion(
      readFileSync(path.join(root, "source_data/README.md"), "utf8"),
    ),
    "v1",
  );
  const imported = await importRepository(root);
  assert.equal(imported.companies.length, 4);
  assert.equal(imported.openings.length, 3);
  assert.ok(
    imported.openings.every(
      (opening) => (opening.description?.length ?? 0) > 100,
    ),
    "All sample postings must have captured text so offline tests never fetch a live board.",
  );
  assert.ok(imported.scan.seenCount > imported.openings.length);
  assert.equal(imported.scan.failedCompanies.length, 1);
  assert.ok(
    imported.documents.some(
      (d) => d.path === currentResumePath && d.status === "current",
    ),
  );
  for (const privacy of ["private", "public"])
    assert.ok(
      imported.documents.some(
        (d) =>
          d.scope === "general" &&
          d.status === "current" &&
          d.format === "pdf" &&
          d.privacy === privacy,
      ),
    );
  assert.ok(
    imported.documents.some(
      (d) => d.scope === "tailored" && d.status === "current",
    ),
  );
  assert.ok(imported.documents.some((d) => d.status === "superseded"));
  assert.equal(
    imported.health.filter((h) => h.severity === "error").length,
    0,
    JSON.stringify(imported.health),
  );
  writeFileSync(
    path.join(root, currentResumePath),
    original + "\n> Isolated note\n",
  );
  assert.equal(
    readFileSync(path.join(sampleWorkspaceRoot, currentResumePath), "utf8"),
    original,
  );
});

test("dev source seeding uses the complete sample without replacing sandbox edits", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sample-dev-seed-"));
  try {
    writeSyntheticRoot(root);
    const resume = path.join(root, currentResumePath);
    assert.match(readFileSync(resume, "utf8"), /SAM RIVERA/);
    writeFileSync(resume, "An isolated sandbox edit.");
    writeSyntheticRoot(root);
    assert.equal(readFileSync(resume, "utf8"), "An isolated sandbox edit.");
    assert.equal(
      readFileSync(
        path.join(root, "source_master_template/v1/resume_private.pdf"),
      )
        .subarray(0, 5)
        .toString(),
      "%PDF-",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
