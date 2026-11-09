import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pdfVerifier } from "../../server/paths.js";
import type { Records } from "../../server/records.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, atomicWrite, sha256 } from "../../server/storage.js";
import { sampleWorkspaceRoot as repositoryRoot } from "../fixtures/sample-workspace.js";
import {
  validateBundle,
  draftPath,
  checkSources,
} from "../../server/bundles.js";
import { applicationEvidencePaths } from "../../server/application-evidence.js";
import { selectablePdf } from "../fixtures/selectable-pdf.js";
import { legacyTask } from "../fixtures/legacy-records.js";

function evidenceRevisionFixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "bundle-evidence-revision-"));
  const store = new Store(root, path.join(root, ".local"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const task = legacyTask({ id: randomUUID(), preset: "resume-revision" });
  const versionDir = "source_master_template/v1";
  const master = `${versionDir}/resume.md`;
  const evidence = "source_data/github_evidence_dossier.md";
  const sourceHashes: Record<string, string> = {};
  for (const relative of [
    master,
    evidence,
    `${versionDir}/resume.html`,
    `${versionDir}/resume_public.html`,
    `${versionDir}/resume_private.pdf`,
    `${versionDir}/resume_public.pdf`,
  ]) {
    const revised = readFileSync(path.join(repositoryRoot, relative));
    const original = relative === master ? "Earlier resume wording." : revised;
    atomicWrite(path.join(root, relative), original);
    atomicWrite(draftPath(store, task.id, relative), revised);
    sourceHashes[relative] = sha256(original);
  }
  atomicWrite(
    path.join(root, "source_data/verify_resume_source_sync.py"),
    readFileSync(
      path.join(repositoryRoot, "source_data/verify_resume_source_sync.py"),
    ),
  );
  const bundle = {
    id: task.id,
    version: 1,
    paths: Object.keys(sourceHashes),
    versionDir,
    master,
    evidence,
    sourceHashes,
  };
  store.put("task", task.id, task);
  return { store, bundle, root };
}

async function verifyStandaloneIsolation(t: TestContext) {
  const inheritedRoot = mkdtempSync(
    path.join(os.tmpdir(), "release-inherited-root-"),
  );
  const inheritedData = mkdtempSync(
    path.join(os.tmpdir(), "release-inherited-data-"),
  );
  t.after(() => {
    rmSync(inheritedRoot, { recursive: true, force: true });
    rmSync(inheritedData, { recursive: true, force: true });
  });
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "app/scripts/verify-release.ts"],
    {
      cwd: path.resolve(import.meta.dirname, "../../.."),
      env: {
        ...process.env,
        JOB_SEARCH_ROOT: inheritedRoot,
        JOB_SEARCH_DATA: inheritedData,
        JOB_SEARCH_VERIFICATION_REPORT: "",
      },
      timeout: 180000,
      maxBuffer: 1000000,
    },
  );
  assert.match(stdout, /PASS optimistic draft conflict/);
  assert.deepEqual(readdirSync(inheritedRoot), []);
  assert.deepEqual(readdirSync(inheritedData), []);
  const report = /^Report (.+)$/m.exec(stdout)?.[1];
  assert.ok(report, stdout);
  t.after(() => rmSync(report, { force: true }));
  assert.equal(
    JSON.parse(readFileSync(report, "utf8")).checks.currentMasterUnchanged,
    true,
  );
}

test("tailored content changes validate without rewriting evidence, while master revisions still require it", async (t) => {
  const { store, bundle } = evidenceRevisionFixture(t);
  for (const privateOnly of [false, true]) {
    store.put("bundle", bundle.id, { ...bundle, privateOnly });
    const result = await validateBundle(store, bundle.id);
    const evidenceCheck = result.validation.checks.find(
      (check) => check.name === "Evidence accompanies content revision",
    );
    assert.equal(evidenceCheck?.status, privateOnly ? "passed" : "failed");
    if (!privateOnly)
      assert.match(evidenceCheck?.output ?? "", /without an evidence update/);
    const failed = result.validation.checks.filter(
      (check) => check.status === "failed",
    );
    assert.deepEqual(
      failed.map((check) => check.name),
      privateOnly ? [] : [evidenceCheck?.name],
    );
    if (process.platform === "darwin" && privateOnly)
      assert.equal(
        result.validation.status,
        "passed",
        JSON.stringify(result.validation.checks),
      );
  }
  if (process.platform === "darwin") await verifyStandaloneIsolation(t);
  rmSync(draftPath(store, bundle.id, bundle.evidence));
  const missing = await validateBundle(store, bundle.id);
  const evidenceCheck = missing.validation.checks.find(
    (check) => check.name === "Evidence accompanies content revision",
  );
  assert.equal(evidenceCheck?.status, "failed");
  assert.equal(evidenceCheck?.output, "Evidence dossier is missing.");
});

test(
  "real mixed-document validation passes correct documents and rejects source/PDF failures",
  { skip: process.platform !== "darwin" },
  async () => {
    const root = mkdtempSync(
      path.join(os.tmpdir(), "fieldwork-bundle-validation-"),
    );
    const store = new Store(root, path.join(root, ".local"));
    const id = randomUUID();
    const dir = "source_master_template/v1";
    // Keep the historical fixture internally consistent as the general master evolves.
    const master = `${dir}/resume.md`;
    const evidence = "source_data/github_evidence_dossier.md";
    const hashes: Record<string, string> = {};
    const put = (file: string, bytes: Buffer | string) => {
      atomicWrite(path.join(root, file), bytes);
      atomicWrite(draftPath(store, id, file), bytes);
      hashes[file] = sha256(bytes);
    };
    const body =
      "This is a local document validation fixture, not an application. " +
      "It exercises selectable text and complete source matching across a one page letter. ".repeat(
        5,
      );
    const lines = [
      "SAM RIVERA",
      "github.com/sam-rivera-example | 202-555-0142 | sam.rivera@example.com",
      body.trim(),
    ];
    const publicLines = [
      lines[0],
      "github.com/sam-rivera-example | sam.rivera@example.com",
      lines[2],
    ];
    try {
      for (const file of [
        master,
        evidence,
        `${dir}/resume.html`,
        `${dir}/resume_public.html`,
        `${dir}/resume_private.pdf`,
        `${dir}/resume_public.pdf`,
      ])
        put(file, readFileSync(path.join(repositoryRoot, file)));
      atomicWrite(
        path.join(root, "source_data/verify_resume_source_sync.py"),
        readFileSync(
          path.join(repositoryRoot, "source_data/verify_resume_source_sync.py"),
        ),
      );
      put(`${dir}/cover_letter.md`, lines.join("\n\n"));
      const html = lines.map((line) => `<p>${line}</p>`).join("");
      put(`${dir}/cover_letter.html`, html);
      put(
        `${dir}/cover_letter_public.html`,
        publicLines.map((line) => `<p>${line}</p>`).join(""),
      );
      put(`${dir}/Sam_Rivera_Cover_Letter.pdf`, selectablePdf(lines));
      put(
        `${dir}/Sam_Rivera_Cover_Letter_public.pdf`,
        selectablePdf(publicLines),
      );
      // A stale nested copy must not enter any current document's validation.
      atomicWrite(
        draftPath(store, id, `${dir}/revisions/old/resume.html`),
        "stale",
      );
      store.put(
        "task",
        id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
        { id, preset: "job-fit", status: "completed" } as Records["task"],
      );
      store.put(
        "bundle",
        id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
        {
          id,
          version: 1,
          versionDir: dir,
          master,
          evidence,
          sourceHashes: hashes,
        } as Records["bundle"],
      );
      const first = await validateBundle(store, id);
      assert.equal(
        first.validation.status,
        "passed",
        JSON.stringify(first.validation.checks),
      );
      assert.equal(
        first.validation.checks.filter((c: any) => /HTML|PDF/.test(c.name))
          .length,
        4,
      );
      assert.equal(store.get("task", id)!.bundle!.status, "validated");

      atomicWrite(
        draftPath(store, id, `${dir}/cover_letter.html`),
        html.replace("local document", "wrong document"),
      );
      let result = await validateBundle(store, id);
      assert.equal(result.validation.status, "failed");
      assert.equal(
        result.validation.checks.find(
          (c: any) =>
            c.name === "Cover letter: Markdown and private/public HTML",
        )?.status,
        "failed",
      );
      atomicWrite(draftPath(store, id, `${dir}/cover_letter.html`), html);

      for (const [pdf, expected] of [
        [selectablePdf(lines, 2), /must contain 1 page/],
        [
          selectablePdf([lines[0], lines[1], "Different content. ".repeat(30)]),
          /does not contain source block/,
        ],
        [Buffer.from("not a PDF"), /Unreadable PDF/],
      ] as const) {
        atomicWrite(
          draftPath(store, id, `${dir}/Sam_Rivera_Cover_Letter.pdf`),
          pdf,
        );
        result = await validateBundle(store, id);
        const check = result.validation.checks.find(
          (c: any) =>
            c.name === "Cover letter: PDF page count and selectable text",
        );
        assert.equal(check?.status, "failed");
        assert.match((check as { output: string }).output, expected);
        assert.equal(
          result.validation.checks.find((c: any) =>
            c.name.startsWith("Resume: PDF"),
          )?.status,
          "passed",
        );
      }
      atomicWrite(
        draftPath(store, id, `${dir}/Sam_Rivera_Cover_Letter.pdf`),
        selectablePdf(lines),
      );
      // A letter body need not repeat the renderer-owned contact header.
      // Neither an absent source phone nor a public filename permits a stray phone.
      const source = path.join(root, "contact-free-letter.md");
      const contactFreePdf = path.join(root, "contact-free-letter.pdf");
      const publicPdf = path.join(root, "contact-free-letter_public.pdf");
      atomicWrite(source, lines[2]);
      atomicWrite(contactFreePdf, selectablePdf([lines[2]]));
      const verify = (pdf: string) =>
        promisify(execFile)(
          "swift",
          [
            "-module-cache-path",
            path.join(root, "verifier-cache"),
            pdfVerifier,
            "--cover-letter",
            source,
            pdf,
          ],
          { timeout: 60000 },
        );
      await verify(contactFreePdf);
      for (const phone of [
        "202-555-0199",
        "(202)555-0199",
        "2025550199",
        "12025550199",
        "+12025550199",
      ]) {
        atomicWrite(contactFreePdf, selectablePdf([lines[2], phone]));
        await assert.rejects(
          verify(contactFreePdf),
          /must not introduce a phone/,
        );
      }
      atomicWrite(source, lines.join("\n\n"));
      atomicWrite(publicPdf, selectablePdf([...publicLines, "202-555-0199"]));
      await assert.rejects(verify(publicPdf), /must not introduce a phone/);
      rmSync(draftPath(store, id, evidence));
      result = await validateBundle(store, id);
      assert.equal(
        result.validation.checks.find(
          (c: any) => c.name === "Evidence accompanies content revision",
        )?.status,
        "failed",
      );
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test("posting drafts keep captured instructions and layouts while evidence and trusted renderer changes remain conflicts", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "posting-source-policy-"));
  const store = new Store(root, path.join(root, ".local/data"));
  try {
    const paths = [
      ...applicationEvidencePaths,
      "AGENTS.md",
      "source_data/README.md",
      "source_master_template/v1/resume.html",
      "source_master_template/v1/render_resume.swift",
    ];
    for (const file of paths) atomicWrite(path.join(root, file), "original");
    const bundle = {
      id: "draft",
      version: 1,
      scope: "posting-draft",
      sourceHashes: Object.fromEntries(
        paths.map((p) => [p, sha256("original")]),
      ),
      paths,
    };
    for (const file of [
      "AGENTS.md",
      "source_data/README.md",
      "source_master_template/v1/resume.html",
      "platform/app/client/styles.css",
      "platform/dist/index.html",
    ])
      atomicWrite(
        path.join(root, file),
        "presentation or developer instruction changes",
      );
    assert.deepEqual(checkSources(store, bundle), []);
    assert.ok(
      checkSources(store, { ...bundle, scope: "general" }).some(
        (c) => c.path === "AGENTS.md",
      ),
    );
    atomicWrite(path.join(root, applicationEvidencePaths[0]), "updated resume");
    assert.deepEqual(
      checkSources(store, bundle).map((c) => c.path),
      [applicationEvidencePaths[0]],
    );
    atomicWrite(
      path.join(root, "source_master_template/v1/render_resume.swift"),
      "changed renderer",
    );
    assert.equal(checkSources(store, bundle).length, 2);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
