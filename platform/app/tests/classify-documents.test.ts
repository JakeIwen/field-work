import {
  currentTailoredDirectories,
  privateDocumentPaths,
} from "../server/import/document-content.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyDocument,
  isImportableDocumentPath,
} from "../server/import/classify-documents.js";

const classify = (
  relative: string,
  raw = "",
  currentVersion: string | null = "v12",
) =>
  classifyDocument({
    relative,
    raw,
    currentVersion,
    currentTailoredDirectories: ["employer_specific/northwind"],
  });

test("document selection keeps supported content and excludes note descriptors", () => {
  const cases: [string, boolean][] = [
    ["old_resume/resume.html", true],
    ["old_resume/resume.PDF", true],
    ["old_resume/notes.md", true],
    ["old_resume/resume.txt", true],
    ["old_resume/resume.docx", true],
    ["old_resume/README.md", false],
    ["source_master_template/v10/v10_revision_notes.md", false],
    ["source_master_template/v2_bad/v2_claim_audit.md", false],
    ["employer_specific/northwind/v10_sync_notes.md", false],
    ["old_resume/resume.rtf", false],
  ];
  for (const [relative, expected] of cases) {
    assert.equal(isImportableDocumentPath(relative), expected, relative);
  }
});

test("complete classification shape preserves the original field values", () => {
  assert.deepEqual(
    classify("source_master_template/v12/resume_public.html", "555-123-4567"),
    {
      base: "resume_public.html",
      parent: "source_master_template/v12",
      format: "html",
      scope: "general",
      company: null,
      versionLabel: "v12",
      versionNumber: 12,
      kind: "resume",
      initialNotesPath: "source_master_template/v12/revision_notes.md",
      fallbackNotesPath: "",
      discardNotes: false,
      privacy: "public",
      isCurrentGeneral: true,
      isCurrentTailored: false,
      status: "current",
      bundleId: "general:v12",
      statusProvenance: "source_data/README.md",
      privacyProvenance: "Explicit public filename",
    },
  );
});

test("scope and company rules use the employer directory without a named-employer allowlist", () => {
  const cases: {
    relative: string;
    scope: "general" | "tailored";
    company: string | null;
  }[] = [
    { relative: "old_resume/northwind.html", scope: "general", company: null },
    {
      relative: "employer_specific/northwind/resume.html",
      scope: "tailored",
      company: "Northwind",
    },
    {
      relative: "employer_specific/bluepine/resume.html",
      scope: "tailored",
      company: "Bluepine",
    },
    {
      relative: "employer_specific/bluepine-northwind/resume.html",
      scope: "tailored",
      company: "Bluepine Northwind",
    },
    {
      relative: "employer_specific/Acme/resume.html",
      scope: "tailored",
      company: "Acme",
    },
    {
      relative: "Employer_specific/northwind/resume.html",
      scope: "general",
      company: null,
    },
    {
      relative: "employer_specific/NORTHWIND/resume.html",
      scope: "tailored",
      company: "Northwind",
    },
  ];
  for (const expected of cases) {
    const actual = classify(expected.relative);
    assert.equal(actual.scope, expected.scope, expected.relative);
    assert.equal(actual.company, expected.company, expected.relative);
  }
});

test("version rules cover directories, filenames, sync copies and fallbacks", () => {
  const cases: [string, string | null, string, number][] = [
    ["source_master_template/v12/resume.html", "v12", "v12", 12],
    ["source_master_template/v9/resume.html", "v12", "v9", 9],
    ["source_master_template/v2_bad/resume.html", "v12", "v2_bad", 2],
    ["source_master_template/V2_BAD/resume.html", "v12", "V2_BAD", 2],
    ["old_resume/Sam_resume_v7_public.html", "v12", "v7_public", 7],
    ["old_resume/resume_v9_pre_v10_sync.html", "v12", "pre-v10 sync", 10],
    ["source_data/resume.md", null, "unknown", 0],
    ["employer_specific/Acme/resume.html", "v12", "legacy / unnumbered", 0],
    ["old_resume/notes.md", "v12", "legacy", 0],
  ];
  for (const [relative, currentVersion, versionLabel, versionNumber] of cases) {
    const actual = classify(relative, "", currentVersion);
    assert.equal(actual.versionLabel, versionLabel, relative);
    assert.equal(actual.versionNumber, versionNumber, relative);
  }
});

test("kind rules recognize generic cover-letter aliases", () => {
  const cases: [string, "cover-letter" | "resume"][] = [
    ["old_resume/cover_letter.pdf", "cover-letter"],
    ["employer_specific/bluepine/cover_letter.txt", "cover-letter"],
    ["employer_specific/bluepine/cover_letter.html", "cover-letter"],
    ["employer_specific/bluepine/cover_letter.pdf", "cover-letter"],
    ["old_resume/resume.html", "resume"],
  ];
  for (const [relative, expected] of cases) {
    assert.equal(classify(relative).kind, expected, relative);
  }
});

test("note descriptors retain initial and fallback reads before discard", () => {
  const cases: [string, string, string, boolean][] = [
    [
      "source_master_template/v12/resume.html",
      "source_master_template/v12/revision_notes.md",
      "",
      false,
    ],
    [
      "source_master_template/v2_bad/resume.html",
      "source_master_template/v2_bad/claim_audit.md",
      "",
      false,
    ],
    [
      "source_master_template/V2_BAD/resume.html",
      "source_master_template/V2_BAD/revision_notes.md",
      "",
      false,
    ],
    [
      "employer_specific/northwind/resume.html",
      "",
      "employer_specific/northwind/README.md",
      false,
    ],
    [
      "employer_specific/northwind/revisions/resume.html",
      "",
      "employer_specific/northwind/revisions/README.md",
      true,
    ],
    [
      "employer_specific/Acme/resume.html",
      "",
      "employer_specific/Acme/README.md",
      false,
    ],
    ["old_resume/notes.md", "", "", false],
  ];
  for (const [relative, initial, fallback, discard] of cases) {
    const actual = classify(relative);
    assert.equal(actual.initialNotesPath, initial, relative);
    assert.equal(actual.fallbackNotesPath, fallback, relative);
    assert.equal(actual.discardNotes, discard, relative);
  }
});

const statusCases: [string, string | null, boolean, boolean, string, string][] =
  [
    [
      "source_master_template/v12/resume.html",
      "v12",
      true,
      false,
      "current",
      "source_data/README.md",
    ],
    [
      "source_master_template/v9/resume.html",
      "v12",
      false,
      false,
      "superseded",
      "Legacy location; no application submission inferred",
    ],
    [
      "source_master_template/v2_bad/resume.html",
      "v12",
      false,
      false,
      "rejected",
      "Explicit rejected directory name v2_bad",
    ],
    [
      "source_master_template/V2_BAD/resume.html",
      "v12",
      false,
      false,
      "superseded",
      "Legacy location; no application submission inferred",
    ],
    [
      "source_master_template/v2_bad/resume.html",
      "v2_bad",
      true,
      false,
      "rejected",
      "source_data/README.md",
    ],
    [
      "source_data/resume.md",
      null,
      true,
      false,
      "current",
      "source_data/README.md",
    ],
    [
      "employer_specific/northwind/resume.html",
      "v12",
      false,
      true,
      "current",
      "employer_specific/northwind/README.md",
    ],
    [
      "employer_specific/northwind/revisions/resume.html",
      "v12",
      false,
      false,
      "superseded",
      "Legacy location; no application submission inferred",
    ],
    [
      "employer_specific/NORTHWIND/resume.html",
      "v12",
      false,
      false,
      "draft",
      "Legacy location; no application submission inferred",
    ],
  ];

test("current and status rules preserve case-sensitive precedence", () => {
  for (const [
    relative,
    version,
    general,
    tailored,
    status,
    provenance,
  ] of statusCases) {
    const actual = classify(relative, "", version);
    assert.equal(actual.isCurrentGeneral, general, relative);
    assert.equal(actual.isCurrentTailored, tailored, relative);
    assert.equal(actual.status, status, relative);
    assert.equal(actual.statusProvenance, provenance, relative);
  }
});

test("privacy and bundle rules preserve exact filename and source evidence", () => {
  const cases: [string, string, string, string, string][] = [
    [
      "employer_specific/northwind/resume_private.pdf",
      "",
      "unknown",
      "No explicit privacy evidence",
      "Northwind:employer_specific/northwind:resume",
    ],
    [
      "employer_specific/northwind/resume_public.pdf",
      "",
      "public",
      "Explicit public filename",
      "Northwind:employer_specific/northwind:resume",
    ],
    [
      "old_resume/resume_public.html",
      "tel:555-123-4567",
      "public",
      "Explicit public filename",
      "general:legacy",
    ],
    [
      "old_resume/resume_linkedin.html",
      "",
      "public",
      "Explicit public filename",
      "general:legacy",
    ],
    [
      "old_resume/resume.html",
      "+1 555-123-4567",
      "private",
      "Phone present in source or explicitly identified by source README",
      "general:legacy",
    ],
    [
      "old_resume/resume.html",
      "No contact details",
      "unknown",
      "No explicit privacy evidence",
      "general:legacy",
    ],
    [
      "employer_specific/bluepine/cover_letter.txt",
      "",
      "unknown",
      "No explicit privacy evidence",
      "Bluepine:employer_specific/bluepine:cover-letter",
    ],
  ];
  for (const [relative, raw, privacy, provenance, bundleId] of cases) {
    const actual = classify(relative, raw);
    assert.equal(actual.privacy, privacy, relative);
    assert.equal(actual.privacyProvenance, provenance, relative);
    assert.equal(actual.bundleId, bundleId, relative);
  }
});

test("employer masters require a directory and a selected version, not merely a filename", () => {
  const loose = classify("employer_specific/resume_private.pdf");
  assert.equal(loose.company, null);
  assert.equal(loose.scope, "general");
  assert.equal(loose.isCurrentTailored, false);
  assert.equal(loose.privacy, "unknown");
  const readme =
    "The current tailored master is separate at `employer_specific/northwind/`.";
  const directories = currentTailoredDirectories(readme);
  assert.deepEqual(
    currentTailoredDirectories(readme.replace("current", "previous")),
    [],
  );
  assert.deepEqual(directories, ["employer_specific/northwind"]);
  assert.equal(
    classifyDocument({
      relative: "employer_specific/northwind/resume.html",
      raw: "",
      currentVersion: null,
      currentTailoredDirectories: directories,
    }).isCurrentTailored,
    true,
  );
  assert.equal(
    classifyDocument({
      relative: "employer_specific/another/resume.html",
      raw: "",
      currentVersion: "v12",
      currentTailoredDirectories: directories,
    }).isCurrentTailored,
    false,
  );
  assert.equal(
    classifyDocument({
      relative: "employer_specific/northwind/resume.html",
      raw: "",
      currentVersion: "v12",
    }).isCurrentTailored,
    false,
  );
});

test("only explicit README privacy declarations identify a private PDF without readable content", () => {
  const relative = "employer_specific/northwind/resume_private.pdf";
  const paths = privateDocumentPaths(
    "Private files: `resume_private.pdf`, `cover_letter_private.pdf`.",
    "employer_specific/northwind",
  );
  const input = { relative, raw: "", currentVersion: "v1" };
  assert.equal(classifyDocument(input).privacy, "unknown");
  assert.equal(
    classifyDocument({ ...input, privateDocumentPaths: paths }).privacy,
    "private",
  );
  assert.equal(
    classifyDocument({
      ...input,
      relative: "employer_specific/other/resume_private.pdf",
      privateDocumentPaths: paths,
    }).privacy,
    "unknown",
  );
});
