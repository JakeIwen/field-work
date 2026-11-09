import {
  fixtureEvidenceHashes,
  saveFixturePdf,
  saveCompletedDocumentTask,
} from "./fixtures/document-records.js";
import { withReadCache } from "../server/storage-read-cache.js";
import {
  generateAutofill,
  savedAutofills,
  savedAutofillScript,
} from "../server/greenhouse-autofill.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { legacyBundle, legacyTask } from "./fixtures/legacy-records.js";
import { atomicWrite, sha256 } from "../server/storage.js";
import { draftPath } from "../server/bundles.js";
import {
  coverLetterRendering,
  postingInstructionParts,
  postingDocumentInstructions,
} from "../server/document-instructions.js";
import {
  writingRuleHashes,
  legacyInstructionParts,
} from "../server/document-writing-rules.js";
import {
  currentDocumentWritingRules,
  capturedDocumentWritingRules,
  documentWritingWarning,
  documentsWithWritingWarnings,
} from "../server/document-writing-status.js";
import {
  preparationDocument,
  reusableDocuments,
  documentOpeningHash,
  documentPostingHash,
} from "../server/preparation-documents.js";
import { ApplicationPreparationManager } from "../server/application-preparation.js";

const guidance = `# Platform operations\nRun the local server.\n# Job Search Writing Guidelines\n## General style\nWrite precisely.\n### Natural company-facing prose\nConnect examples to the role.\n## Cover letters\nUse three paragraphs.\n## Resume writing\nKeep bullets concise.\n## Job-search harvest completeness\nUse a seven-day search window.\n# Platform code structure\nUse shared libraries.\n`;
const template = {
  master: "source_data/resume.md",
  versionDir: "source_master_template/v14",
};

test("writing fingerprints distinguish document kinds and ignore app operations and wrapping", () => {
  const parts = postingInstructionParts("posting-application", template);
  const before = writingRuleHashes(guidance, parts);
  const cover = writingRuleHashes(
    guidance.replace("Use three paragraphs.", "Use four paragraphs."),
    parts,
  );
  assert.equal(cover.resume, before.resume);
  assert.notEqual(cover["cover-letter"], before["cover-letter"]);
  const resume = writingRuleHashes(
    guidance.replace(
      "Keep bullets concise.",
      "Keep the most relevant bullets.",
    ),
    parts,
  );
  assert.notEqual(resume.resume, before.resume);
  assert.equal(resume["cover-letter"], before["cover-letter"]);
  const prose = writingRuleHashes(
    guidance.replace(
      "Connect examples to the role.",
      "Lead with professional experience.",
    ),
    parts,
  );
  assert.equal(prose.resume, before.resume);
  assert.notEqual(prose["cover-letter"], before["cover-letter"]);
  assert.deepEqual(
    writingRuleHashes(
      guidance
        .replace("Run the local server.", "Change the app layout.")
        .replace("seven-day", "fourteen-day")
        .replace("Write precisely.", "Write\nprecisely."),
      parts,
    ),
    before,
  );
  const common = writingRuleHashes(
    guidance.replace("Write precisely.", "Write plainly."),
    parts,
  );
  assert.notEqual(common.resume, before.resume);
  assert.notEqual(common["cover-letter"], before["cover-letter"]);
});

test("cover-letter rendering mechanics do not change writing fingerprints", () => {
  for (const preset of ["posting-cover-letter", "posting-application"]) {
    const parts = postingInstructionParts(preset, template);
    assert.ok(parts.coverLetter?.endsWith(coverLetterRendering), preset);
    assert.deepEqual(
      writingRuleHashes(guidance, {
        ...parts,
        coverLetter: parts.coverLetter?.replace(` ${coverLetterRendering}`, ""),
      }),
      writingRuleHashes(guidance, parts),
      preset,
    );
  }
});

test("task writing instructions are tracked per kind and legacy snapshots match unchanged policy", () => {
  for (const preset of [
    "posting-application",
    "posting-resume",
    "posting-cover-letter",
  ]) {
    const parts = postingInstructionParts(preset, template);
    const legacy = legacyInstructionParts(
      postingDocumentInstructions(preset, template, "Example role"),
    );
    assert.ok(legacy);
    assert.deepEqual(
      writingRuleHashes(guidance, legacy),
      writingRuleHashes(guidance, parts),
    );
  }
  const parts = postingInstructionParts("posting-application", template);
  const before = writingRuleHashes(guidance, parts);
  const changed = writingRuleHashes(guidance, {
    ...parts,
    coverLetter: parts.coverLetter + " Avoid label sentences.",
  });
  assert.equal(changed.resume, before.resume);
  assert.notEqual(changed["cover-letter"], before["cover-letter"]);
  const renamed = writingRuleHashes(
    guidance,
    postingInstructionParts("posting-application", {
      master: "different/master.md",
      versionDir: "source_master_template/v99",
    }),
  );
  assert.deepEqual(
    renamed,
    before,
    "implementation paths do not change writing policy",
  );
});

function documentFixture(legacy = false) {
  const f = applicationAnswerFixture();
  const id = randomUUID();
  atomicWrite(path.join(f.root, "AGENTS.md"), guidance);
  const rules = writingRuleHashes(
    guidance,
    postingInstructionParts("posting-application", template),
  );
  const task = saveCompletedDocumentTask(
    f.store,
    legacyTask({ id, preset: "posting-application" }),
    "one",
    ["resume", "letter"],
    {
      ...template,
      sourceHashes: fixtureEvidenceHashes(f.store),
      ...(legacy ? {} : { writingRuleHashes: rules }),
    },
    documentPostingHash(f.api),
  );
  atomicWrite(draftPath(f.store, id, "AGENTS.md"), guidance);
  atomicWrite(
    draftPath(f.store, id, "DOCUMENT-INSTRUCTIONS.md"),
    postingDocumentInstructions("posting-application", template),
  );
  const docs = (["resume", "cover-letter"] as const).map((kind) =>
    saveFixturePdf(
      f.store,
      {
        id: kind === "resume" ? "resume" : "letter",
        openingId: "one",
        origin: "generated",
        kind,
        generatedBy: id,
        createdAt: "2026-10-01",
        ...(legacy ? {} : { writingRuleHash: rules[kind] }),
      },
      Buffer.from("%PDF-1.4 fixture " + kind),
    ),
  );
  return { ...f, task, docs };
}

test("legacy PDFs are compared with their captured instructions without rewriting files", () => {
  const f = documentFixture(true);
  try {
    assert.equal(documentWritingWarning(f.store, f.docs[1]), undefined);
    const original = readFileSync(f.store.objectPath(f.docs[1].hash));
    atomicWrite(
      path.join(f.root, "AGENTS.md"),
      guidance.replace("Use three paragraphs.", "Use four paragraphs."),
    );
    assert.equal(documentWritingWarning(f.store, f.docs[0]), undefined);
    assert.match(
      documentWritingWarning(f.store, f.docs[1]) ?? "",
      /Cover letter writing rules changed/,
    );
    assert.deepEqual(
      readFileSync(f.store.objectPath(f.docs[1].hash)),
      original,
    );
    rmSync(draftPath(f.store, f.task.id, "DOCUMENT-INSTRUCTIONS.md"));
    assert.match(
      documentWritingWarning(f.store, f.docs[1]) ?? "",
      /could not be verified/,
    );
  } finally {
    f.cleanup();
  }
});

test("app edits preserve current PDFs; writing edits exclude only affected reuse candidates", () => {
  const f = documentFixture();
  try {
    for (const file of [
      "platform/app/client/App.tsx",
      "platform/app/client/styles.css",
      "platform/app/server/question-context.ts",
      "source_data/README.md",
    ])
      atomicWrite(path.join(f.root, file), "Unrelated app change");
    assert.equal(reusableDocuments(f.store, "one").length, 2);
    atomicWrite(
      path.join(f.root, "AGENTS.md"),
      guidance.replace("Use three paragraphs.", "Use four paragraphs."),
    );
    assert.deepEqual(
      reusableDocuments(f.store, "one").map((doc) => doc.kind),
      ["resume"],
    );
    assert.doesNotThrow(
      () => preparationDocument(f.store, "one", "letter"),
      "saved output remains readable",
    );
    assert.equal(
      reusableDocuments(f.store, "one", undefined, f.task.id).length,
      2,
      "an in-flight task may finish under captured rules",
    );
    const projected = documentsWithWritingWarnings(
      f.store,
      f.docs,
      f.store.taskSummaries(),
    );
    assert.equal(projected[0].writingRuleWarning, undefined);
    assert.match(projected[1].writingRuleWarning ?? "", /Cover letter/);
  } finally {
    f.cleanup();
  }
});

test("Generate Docs selects a cover-letter task when only cover-letter policy changed", async () => {
  const f = documentFixture();
  const presets: string[] = [];
  const opening = f.store.opening("one");
  assert.ok(opening);
  f.store.put("cache_opening", "one", {
    ...opening,
    url: "https://example.com/jobs/one",
  });
  const manager = new ApplicationPreparationManager(f.store, {
    changed() {},
    generateScript: async () => {
      throw new Error("Unsupported form should not be fetched");
    },
    startAnswers: async () => undefined,
    createDocuments: async (run, preset) => {
      presets.push(preset);
      const task = legacyTask({
        id: randomUUID(),
        preset: "posting-cover-letter",
        status: "running",
        context: { openingId: run.openingId },
      });
      f.store.put("task", task.id, task);
      return task;
    },
    startTask: async () => undefined,
  });
  try {
    f.store.put("task", f.task.id, {
      ...f.task,
      preparationOpeningHash: documentOpeningHash(f.store.opening("one")),
    });
    atomicWrite(
      path.join(f.root, "AGENTS.md"),
      guidance.replace("Use three paragraphs.", "Use four paragraphs."),
    );
    manager.start("one");
    await manager.tick();
    await manager.tick();
    assert.deepEqual(presets, ["posting-cover-letter"]);
    assert.deepEqual(f.store.document("resume")?.hash, f.docs[0].hash);
  } finally {
    await manager.close();
    f.cleanup();
  }
});

test("scripts flag outdated attached writing without changing their saved bytes", async () => {
  const f = documentFixture();
  try {
    f.form.html = f.form.html.replace(
      "</form>",
      '<div class="file-upload"><div id="upload-label-resume">Resume/CV</div><input id="resume" type="file"></div><div class="file-upload"><div id="upload-label-cover_letter">Cover letter</div><input id="cover_letter" type="file"></div></form>',
    );
    const script = await generateAutofill(f.store, "one", f.read, {
      documentIds: f.docs.map((doc) => doc.id),
      preparationId: "run",
    });
    const original = savedAutofillScript(f.store, "one", script.id).script;
    assert.equal(savedAutofills(f.store, "one")[0].stale, false);
    atomicWrite(
      path.join(f.root, "AGENTS.md"),
      guidance.replace("Use three paragraphs.", "Use four paragraphs."),
    );
    const changed = savedAutofills(f.store, "one")[0];
    assert.equal(changed.stale, true);
    assert.deepEqual(changed.staleReasons, [
      "Cover letter writing rules changed. Generate a new cover letter.",
    ]);
    assert.equal(
      savedAutofillScript(f.store, "one", script.id).script,
      original,
    );
    const revised = currentDocumentWritingRules(f.store, f.task);
    assert.ok(f.task.bundle);
    f.store.put("task", f.task.id, {
      ...f.task,
      bundle: { ...f.task.bundle, writingRuleHashes: revised },
    });
    assert.match(
      documentWritingWarning(f.store, f.docs[1]) ?? "",
      /Cover letter writing rules changed/,
      "new task metadata cannot relabel an older document's captured rules",
    );
  } finally {
    f.cleanup();
  }
});

test("cover-letter editorial review triggers do not expire resumes", () => {
  const current = postingInstructionParts("posting-application", template);
  const earlier = {
    ...current,
    editorial: current.editorial.replace(
      /, plus the AGENTS\.md review triggers:[\s\S]*?(?= Repair unsupported claims)/,
      ".",
    ),
  };
  assert.notEqual(earlier.editorial, current.editorial);
  const before = writingRuleHashes(guidance, earlier),
    after = writingRuleHashes(guidance, current);
  assert.equal(after.resume, before.resume);
  assert.notEqual(after["cover-letter"], before["cover-letter"]);
  const shared = writingRuleHashes(guidance, {
    ...current,
    editorial: current.editorial + " Use only supported employment dates.",
  });
  assert.notEqual(shared.resume, after.resume);
  assert.notEqual(shared["cover-letter"], after["cover-letter"]);
});

test("private-only output mechanics do not expire unchanged writing", () => {
  const current = postingInstructionParts("posting-application", template);
  assert.ok(current.resume && current.coverLetter);
  const previous = {
    ...current,
    resume: current.resume
      .replace("private HTML under", "private/public HTML under")
      .replace(
        "Keep the Markdown and private HTML substantively identical, including the phone number.",
        "They must have identical substantive wording with only the phone omitted publicly.",
      )
      .replace("Do not create or edit public tailored resume variants. ", "")
      .replace(
        "The backend renders one private resume PDF after your turn and validates Markdown/HTML synchronization, two-page fit, selectable text and contact links.",
        "The backend regenerates the two PDFs after your turn and runs the existing Markdown/private/public/PDF validators.",
      ),
    coverLetter: current.coverLetter
      .replace(
        "The private resume AND the cover letter are required in this one task.",
        "Both resume variants AND the cover letter are required in this one task.",
      )
      .replace(" Do not produce public variants.", ""),
  };
  assert.deepEqual(
    writingRuleHashes(guidance, previous),
    writingRuleHashes(guidance, current),
  );
});

test("task operations do not expire PDFs while common writing guidance does", () => {
  const current = postingInstructionParts("posting-application", template);
  const before = writingRuleHashes(guidance, current);
  assert.deepEqual(
    writingRuleHashes(guidance, {
      ...current,
      common: current.common
        .replace("Do not delegate.", "Delegation is disabled.")
        .replace(
          "Write only in this isolated task directory.",
          "Use the assigned workspace.",
        )
        .replace("trusted renderers", "the local renderer"),
    }),
    before,
  );
  const changed = writingRuleHashes(guidance, {
    ...current,
    common: current.common.replace(
      "restrained metrics",
      "qualified metrics with context",
    ),
  });
  assert.notEqual(changed.resume, before.resume);
  assert.notEqual(changed["cover-letter"], before["cover-letter"]);
});

test("request-local writing hashes distinguish source text and instruction parts", () => {
  const f = documentFixture();
  try {
    const texts = [
      guidance,
      guidance.replace("Use three paragraphs.", "Use four paragraphs."),
      guidance.replace("Keep bullets concise.", "Keep only relevant bullets."),
      guidance,
    ];
    const tasks = [
      f.task,
      ...(
        [
          "posting-resume",
          "posting-cover-letter",
          "posting-application",
        ] as const
      ).map((preset) => ({
        ...f.task,
        preset,
        bundle: legacyBundle({
          master: "different/resume.md",
          versionDir: "different/template",
        }),
      })),
    ];
    withReadCache(f.store, () => {
      for (const text of texts)
        for (const task of tasks)
          assert.deepEqual(
            currentDocumentWritingRules(f.store, task, text),
            writingRuleHashes(
              text,
              postingInstructionParts(task.preset, task.bundle ?? {}),
            ),
          );
    });
  } finally {
    f.cleanup();
  }
});

test("writing-warning projections match unscoped reads and reread current policy each request", () => {
  for (const legacy of [false, true]) {
    const f = documentFixture(legacy);
    try {
      const tasks = f.store.taskSummaries();
      const project = () =>
        documentsWithWritingWarnings(f.store, f.docs, tasks);
      const scoped = () => withReadCache(f.store, project);
      assert.deepEqual(scoped(), project());
      assert.deepEqual(
        scoped().map((doc) => doc.writingRuleWarning),
        [undefined, undefined],
      );
      atomicWrite(
        path.join(f.root, "AGENTS.md"),
        guidance.replace("Use three paragraphs.", "Use four paragraphs."),
      );
      assert.deepEqual(scoped(), project());
      assert.equal(scoped()[0].writingRuleWarning, undefined);
      assert.match(
        scoped()[1].writingRuleWarning ?? "",
        /writing rules changed/,
      );
      rmSync(path.join(f.root, "AGENTS.md"));
      assert.deepEqual(scoped(), project());
      for (const doc of scoped())
        assert.match(doc.writingRuleWarning ?? "", /could not be checked/);
      atomicWrite(path.join(f.root, "AGENTS.md"), guidance);
      assert.deepEqual(scoped(), project());
      assert.deepEqual(
        scoped().map((doc) => doc.writingRuleWarning),
        [undefined, undefined],
      );
    } finally {
      f.cleanup();
    }
  }
});

test("legacy writing captures reread changed, deleted and corrupt drafts on the next request", () => {
  const f = documentFixture(true);
  try {
    const tasks = f.store.taskSummaries();
    const project = () => documentsWithWritingWarnings(f.store, f.docs, tasks);
    const scoped = () => withReadCache(f.store, project);
    const instructions = draftPath(
      f.store,
      f.task.id,
      "DOCUMENT-INSTRUCTIONS.md",
    );
    const capturedAgents = draftPath(f.store, f.task.id, "AGENTS.md");
    withReadCache(f.store, () => {
      const captured = capturedDocumentWritingRules(f.store, f.task);
      assert.ok(captured);
      assert.deepEqual(scoped(), project());
      rmSync(instructions);
      assert.deepEqual(capturedDocumentWritingRules(f.store, f.task), captured);
    });
    assert.deepEqual(scoped(), project());
    for (const doc of scoped())
      assert.match(doc.writingRuleWarning ?? "", /could not be verified/);
    atomicWrite(instructions, "Corrupt historical instruction snapshot");
    assert.deepEqual(scoped(), project());
    for (const doc of scoped())
      assert.match(doc.writingRuleWarning ?? "", /could not be verified/);
    atomicWrite(
      instructions,
      postingDocumentInstructions("posting-application", template),
    );
    atomicWrite(
      capturedAgents,
      guidance.replace("Use three paragraphs.", "Use four paragraphs."),
    );
    assert.deepEqual(scoped(), project());
    assert.equal(scoped()[0].writingRuleWarning, undefined);
    assert.match(scoped()[1].writingRuleWarning ?? "", /writing rules changed/);
    rmSync(capturedAgents);
    assert.deepEqual(scoped(), project());
    for (const doc of scoped())
      assert.match(doc.writingRuleWarning ?? "", /could not be verified/);
    atomicWrite(capturedAgents, guidance);
    assert.deepEqual(scoped(), project());
    assert.deepEqual(
      scoped().map((doc) => doc.writingRuleWarning),
      [undefined, undefined],
    );
  } finally {
    f.cleanup();
  }
});

test("read caching rechecks writing changes and PDF corruption on the next request", () => {
  const f = documentFixture();
  try {
    const list = () =>
      withReadCache(f.store, () => reusableDocuments(f.store, "one"));
    assert.equal(list().length, 2);
    atomicWrite(
      path.join(f.root, "AGENTS.md"),
      guidance.replace("Use three paragraphs.", "Use four paragraphs."),
    );
    assert.deepEqual(
      list().map((doc) => doc.kind),
      ["resume"],
    );
    atomicWrite(
      f.store.objectPath(f.docs[0].hash),
      "%PDF-1.4 corrupted fixture",
    );
    assert.deepEqual(list(), []);
  } finally {
    f.cleanup();
  }
});
