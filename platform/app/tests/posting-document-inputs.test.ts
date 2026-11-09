import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  currentResumePath,
  evidenceDossierPath,
} from "../server/application-evidence.js";
import {
  checkSources,
  draftPath,
  prepareBundle,
  writeDraftArtifact,
} from "../server/bundles.js";
import { contextTool } from "../server/context-tools.js";
import {
  postingDocumentInstructions,
  postingInstructionParts,
} from "../server/document-instructions.js";
import {
  agentWritingRules,
  legacyInstructionParts,
  writingRuleHashes,
} from "../server/document-writing-rules.js";
import {
  capturedDocumentWritingRules,
  currentDocumentWritingRules,
} from "../server/document-writing-status.js";
import { sampleWorkspaceRoot as repositoryRoot } from "./fixtures/sample-workspace.js";
import {
  preparePostingDocumentBundle,
  prepareQuestionBundle,
  questionReferenceId,
} from "../server/question-context.js";
import { Store, atomicWrite, sha256 } from "../server/storage.js";
import { resumeSourceTools } from "../server/task-kinds/source-tools.js";
import { legacyDocument, legacyTask } from "./fixtures/legacy-records.js";

const agents = readFileSync(path.join(repositoryRoot, "AGENTS.md"), "utf8");
const versionDir = "source_master_template/v1";
const reference = { id: questionReferenceId, text: "Historical preferences." };
const posting = { kind: "pasted", text: "A software role.", hash: "posting" };
// Baseline fingerprints with optional reference mechanics excluded, for the neutral writing rules in sample-workspace/AGENTS.md.
const resumeHash =
  "1127df6f773c7b5b544b81875d8427604c41792d39f6b76c3e0417a1464d58ed";
const expectedWritingHashes = {
  "posting-application": {
    resume: resumeHash,
    "cover-letter":
      "c2337581bf3157d440678ed9945fb59c8c93b01b2f95c212762429b3f0ee67db",
  },
  "posting-resume": { resume: resumeHash },
  "posting-cover-letter": {
    "cover-letter":
      "0ffae7a271159d12b369d2cc8767372c860b6ced427377df10f021510c7a0fb5",
  },
};

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "posting-document-inputs-"));
  const store = new Store(root, path.join(root, ".local/data"));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const files = {
    "AGENTS.md": agents,
    "README.md": "Fixture workspace.",
    "source_data/README.md": "Fixture master ownership.",
    [currentResumePath]: "Current resume.",
    [evidenceDossierPath]: "Current evidence and limitations.",
    [`${versionDir}/resume.md`]: "Current resume.",
    [`${versionDir}/resume.html`]: "<p>Current resume.</p>",
    [`${versionDir}/resume_public.html`]: "<p>Current resume.</p>",
  };
  for (const [relative, content] of Object.entries(files))
    atomicWrite(path.join(root, relative), content);
  store.put(
    "cache_document",
    "master",
    legacyDocument({
      id: "master",
      path: `${versionDir}/resume.html`,
      scope: "general",
      status: "current",
      kind: "resume",
      format: "html",
      privacy: "private",
    }),
  );
  return store;
}

for (const preset of [
  "posting-application",
  "posting-resume",
  "posting-cover-letter",
] as const) {
  test(`${preset} captures writing-only policy and blocks dossier rewrites`, (t) => {
    const store = fixture(t);
    const task = legacyTask({
      id: randomUUID(),
      threadId: randomUUID(),
      preset,
      status: "running",
      posting,
    });
    const prepared = preparePostingDocumentBundle(store, task, reference);
    store.put("task", task.id, { ...task, ...prepared });
    const read = (source: string) =>
      contextTool(store, task.threadId!, "read_job_search_source", {
        path: source,
      });
    const policy = read("AGENTS.md");
    assert.equal(policy.text, agentWritingRules(agents).markdown);
    assert.match(policy.text, /^# Job Search Writing Guidelines\n/);
    assert.match(policy.text, /## Cover letters/);
    assert.match(policy.text, /## Resume writing/);
    assert.doesNotMatch(
      policy.text,
      /# Platform UX|# Platform operations|# Resume project instructions|## Job-search harvest completeness/,
    );
    // The sample is mostly writing rules; the synthetic operations test below checks the stronger slimming ratio.
    assert.ok(Buffer.byteLength(policy.text) < Buffer.byteLength(agents));
    assert.equal(policy.hash, sha256(policy.text));
    assert.notEqual(policy.hash, sha256(agents));
    assert.equal(prepared.bundle.sourceHashes["AGENTS.md"], sha256(agents));
    const manifest = JSON.parse(read("context-manifest.json").text);
    assert.equal(manifest.sourceHashes["AGENTS.md"], sha256(agents));
    assert.deepEqual(checkSources(store, prepared.bundle, false), []);
    assert.equal(prepared.bundle.privateOnly, true);
    assert.deepEqual(
      prepared.bundle.writingRuleHashes,
      expectedWritingHashes[preset],
    );
    assert.deepEqual(
      currentDocumentWritingRules(store, { ...task, bundle: prepared.bundle }),
      expectedWritingHashes[preset],
    );
    assert.deepEqual(
      writingRuleHashes(
        agentWritingRules(agents).markdown,
        postingInstructionParts(preset, prepared.bundle, {
          referenceConversation: true,
        }),
      ),
      writingRuleHashes(
        agentWritingRules(agents).markdown,
        postingInstructionParts(preset, prepared.bundle),
      ),
    );
    const instructions = read("DOCUMENT-INSTRUCTIONS.md").text;
    assert.match(
      instructions,
      /github_evidence_dossier.md is read-only reference/,
    );
    assert.doesNotMatch(instructions, /Add a dated tailoring note/);
    assert.throws(
      () =>
        contextTool(store, task.threadId!, "write_application_source", {
          path: evidenceDossierPath,
          expectedHash: read(evidenceDossierPath).hash,
          content: "An unnecessary rewrite.",
        }),
      /not an allowed draft write/,
    );
    assert.equal(
      read(evidenceDossierPath).text,
      "Current evidence and limitations.",
    );
    const writable =
      preset === "posting-cover-letter"
        ? "cover_letter.txt"
        : currentResumePath;
    contextTool(store, task.threadId!, "write_application_source", {
      path: writable,
      expectedHash: read(writable).hash,
      content: "Tailored document content.",
    });
    assert.equal(read(writable).text, "Tailored document content.");
  });
}

test("general resume revision retains full instructions and editable dossier evidence", (t) => {
  const store = fixture(t);
  const task = legacyTask({ id: randomUUID(), preset: "resume-revision" });
  const prepared = prepareBundle(store, task);
  store.put("task", task.id, { ...task, ...prepared });
  const policy = readFileSync(draftPath(store, task.id, "AGENTS.md"), "utf8");
  assert.ok(policy.startsWith(agents));
  assert.match(policy, /# Isolated application task/);
  assert.match(
    policy,
    /keep Markdown, evidence and both HTML\/PDF variants synchronized/,
  );
  assert.equal(prepared.bundle.privateOnly, undefined);
  assert.deepEqual(checkSources(store, prepared.bundle), []);
  assert.ok(
    resumeSourceTools
      .allowedWritePaths?.(task, prepared.bundle)
      .includes(evidenceDossierPath),
  );
  // Ordinary resume revision uses filesystem drafts, not the posting-only context write tool.
  writeDraftArtifact(
    store,
    task.id,
    evidenceDossierPath,
    prepared.bundle.sourceHashes[evidenceDossierPath],
    "New evidence for a general-master revision.",
  );
  assert.equal(
    readFileSync(draftPath(store, task.id, evidenceDossierPath), "utf8"),
    "New evidence for a general-master revision.",
  );
});

test("question bundles still capture the complete original AGENTS.md", (t) => {
  const store = fixture(t);
  const task = legacyTask({ id: randomUUID(), preset: "questions", posting });
  const prepared = prepareQuestionBundle(store, task, reference);
  assert.equal(
    readFileSync(path.join(prepared.cwd, "AGENTS.md"), "utf8"),
    agents,
  );
  assert.equal(prepared.bundle.sourceHashes["AGENTS.md"], sha256(agents));
});

test("sample current and legacy instructions preserve the same writing fingerprints", (t) => {
  const store = fixture(t);
  for (const preset of [
    "posting-application",
    "posting-resume",
    "posting-cover-letter",
  ] as const) {
    for (const privateOnly of [false, true]) {
      const bundle = { master: currentResumePath, versionDir, privateOnly };
      const parts = postingInstructionParts(preset, bundle);
      const copiedAgents = privateOnly
        ? agentWritingRules(agents).markdown
        : agents;
      assert.deepEqual(
        writingRuleHashes(copiedAgents, parts),
        expectedWritingHashes[preset],
      );
      const instructions = postingDocumentInstructions(preset, bundle);
      const legacy = legacyInstructionParts(instructions);
      assert.ok(legacy);
      assert.deepEqual(
        writingRuleHashes(copiedAgents, legacy),
        expectedWritingHashes[preset],
      );
      const task = legacyTask({ id: randomUUID(), preset });
      atomicWrite(draftPath(store, task.id, "AGENTS.md"), copiedAgents);
      atomicWrite(
        draftPath(store, task.id, "DOCUMENT-INSTRUCTIONS.md"),
        instructions,
      );
      assert.deepEqual(
        capturedDocumentWritingRules(store, task),
        expectedWritingHashes[preset],
      );
    }
  }
});

test("writing-policy projection preserves Markdown order and fences without harvest rules", () => {
  const markdown =
    "# Platform operations\nOmit.\n# Job Search Writing Guidelines\nIntroduction.\n## General style\nKeep prose.\n```md\n# Not a real section\n```\n## Cover letters\nLetter guidance.\n## Resume writing\nResume guidance.\n### Naming decisions\nShared names.\n## Job-search harvest completeness\nOmit discovery.\n# Other section\nOmit.\n";
  const rules = agentWritingRules(markdown);
  assert.equal(
    rules.markdown,
    "# Job Search Writing Guidelines\nIntroduction.\n## General style\nKeep prose.\n```md\n# Not a real section\n```\n## Cover letters\nLetter guidance.\n## Resume writing\nResume guidance.\n### Naming decisions\nShared names.\n",
  );
  assert.deepEqual(agentWritingRules(rules.markdown), rules);
});

test("posting policy excludes large operational sections from the sample writing rules", (t) => {
  const store = fixture(t);
  const operational =
    agents +
    "\n\n# Platform operations\n\n" +
    "Operational data is not writing policy.\n".repeat(3000);
  atomicWrite(path.join(store.root, "AGENTS.md"), operational);
  const task = legacyTask({
    id: randomUUID(),
    preset: "posting-resume",
    posting,
  });
  const prepared = preparePostingDocumentBundle(store, task, null);
  const text = readFileSync(draftPath(store, task.id, "AGENTS.md"), "utf8");
  assert.equal(text, agentWritingRules(agents).markdown);
  assert.ok(Buffer.byteLength(text) < Buffer.byteLength(operational) / 4);
  assert.doesNotMatch(text, /Operational data/);
  assert.equal(prepared.bundle.sourceHashes["AGENTS.md"], sha256(operational));
});
