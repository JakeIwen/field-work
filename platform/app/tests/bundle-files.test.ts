import test from "node:test";
import assert from "node:assert/strict";
import { artifactInfo } from "../shared/bundle-files.js";
import { bundleDocuments } from "../server/bundle-documents.js";

test("task file labels distinguish source copies, outputs, instructions, reports and history", () => {
  const original = {
    "README.md": "same",
    "resume.md": "old",
    "resume.pdf": "old",
  };
  const cases = [
    [{ path: "README.md", hash: "same" }, "references", "Unchanged copy"],
    [{ path: "resume.md", hash: "new" }, "changes", "Modified copy"],
    [{ path: "resume.pdf", hash: "new" }, "documents", "Updated PDF"],
    [
      { path: "Sam_Rivera_Cover_Letter.pdf", hash: "new" },
      "documents",
      "New PDF",
    ],
    [{ path: "cover_letter.html", hash: "new" }, "changes", "New source"],
    [
      { path: "AGENTS.md", hash: "app-appended-instructions" },
      "task",
      "Task instructions",
    ],
    [
      { path: "context-manifest.json", hash: "new" },
      "task",
      "Task instructions",
    ],
    [
      { path: ".agent/handoffs/materials.md", hash: "new" },
      "task",
      "Task instructions",
    ],
    [{ path: "validation/resume.txt", hash: "new" }, "validation", "Report"],
    [
      { path: "revisions/previous/resume.pdf", hash: "new" },
      "history",
      "Saved revision",
    ],
    ["README.md", "task", "Not compared"],
  ] as const;
  for (const [item, group, label] of cases)
    assert.deepEqual(artifactInfo(item, original), { group, label });
});

const dir = "source_master_template/v10";
const master = "source_data/master.md";
const mixed = [
  master,
  `${dir}/resume.md`,
  ...["cover_letter", "resume_2026_design_source_v10"].flatMap((name) =>
    [".html", "_public.html"].map((suffix) => `${dir}/${name}${suffix}`),
  ),
  ...["Cover_Letter", "Resume"].flatMap((kind) =>
    [".pdf", "_public.pdf"].map(
      (suffix) => `${dir}/Sam_Rivera_${kind}_Tailspin${suffix}`,
    ),
  ),
  `${dir}/cover_letter.md`,
  `${dir}/revisions/old/resume.html`,
  `${dir}/validation/resume.pdf`,
].map((path) => ({ path }));

test("mixed resume and cover-letter selection is independent of traversal order and nested backups", () => {
  for (const artifacts of [mixed, [...mixed].reverse()]) {
    const result = bundleDocuments(artifacts, dir, master);
    assert.deepEqual(result.errors, []);
    assert.equal(result.documents.length, 2);
    const [resume, letter] = result.documents;
    assert.equal(resume.source, master);
    assert.equal(
      resume.privateHtml,
      `${dir}/resume_2026_design_source_v10.html`,
    );
    assert.equal(resume.privatePdf, `${dir}/Sam_Rivera_Resume_Tailspin.pdf`);
    assert.equal(letter.source, `${dir}/cover_letter.md`);
    assert.equal(letter.publicHtml, `${dir}/cover_letter_public.html`);
    assert.equal(
      letter.publicPdf,
      `${dir}/Sam_Rivera_Cover_Letter_Tailspin_public.pdf`,
    );
  }
});

test("missing or ambiguous current document variants and unidentified files fail selection", () => {
  for (const missing of [
    master,
    `${dir}/cover_letter.md`,
    `${dir}/resume_2026_design_source_v10_public.html`,
    `${dir}/Sam_Rivera_Resume_Tailspin_public.pdf`,
  ]) {
    const result = bundleDocuments(
      mixed.filter((a) => a.path !== missing),
      dir,
      master,
    );
    assert.ok(result.errors.length, missing);
  }
  for (const extra of [
    "another_resume.html",
    "another_Cover_Letter_public.pdf",
    "application.pdf",
  ]) {
    const result = bundleDocuments(
      [...mixed, { path: `${dir}/${extra}` }],
      dir,
      master,
    );
    assert.ok(result.errors.length, extra);
  }
  const onlyResume = mixed.filter((a) => !/cover_letter/i.test(a.path));
  assert.deepEqual(bundleDocuments(onlyResume, dir, master).errors, []);
  assert.equal(bundleDocuments(onlyResume, dir, master).documents.length, 1);
});

test("private-only application validation requires its private pair and leaves general-master checks strict", () => {
  const privateOnly = mixed.filter(
    (file) =>
      !file.path.includes("_public") &&
      !/cover_letter|Cover_Letter/.test(file.path),
  );
  const selected = bundleDocuments(privateOnly, dir, master, true);
  assert.deepEqual(selected.errors, []);
  assert.equal(selected.documents.length, 1);
  assert.equal(selected.documents[0].publicHtml, undefined);
  assert.equal(selected.documents[0].publicPdf, undefined);
  assert.ok(bundleDocuments(privateOnly, dir, master).errors.length);
  assert.ok(
    bundleDocuments(
      privateOnly.filter((file) => !file.path.endsWith(".html")),
      dir,
      master,
      true,
    ).errors.length,
  );
});
