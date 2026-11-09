import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Capture an explicit deployment choice before loading the workspace modules.
process.env.FIELDWORK_REFERENCE_THREAD_ID = "fixture-reference-thread";
const { openFixtureWorkspace } = await import("./fixtures/http-workspace.js");
const { sampleWorkspaceRoot } = await import("./fixtures/sample-workspace.js");
const {
  prepareQuestionBundle,
  preparePostingDocumentBundle,
  questionPrompt,
  postingDocumentPrompt,
  questionReferenceId,
} = await import("../server/question-context.js");

test("missing optional reference does not block Questions or Generate Docs; a present reference is retained", async () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "optional-reference-"));
  const workspace = await openFixtureWorkspace(sampleWorkspaceRoot, dataDir);
  try {
    workspace.agent.readReferenceThread = async () => {
      throw new Error("Thread not found");
    };
    const missing = await (
      await workspace.get("/api/questions/context")
    ).json();
    assert.equal(missing.reference, null);
    assert.equal(missing.referenceError, null);
    for (const preset of [
      "questions",
      "posting-resume",
      "posting-cover-letter",
      "posting-application",
    ]) {
      const task = {
        id: randomUUID(),
        preset,
        posting: {
          kind: "pasted",
          text: "Synthetic software role",
          hash: "posting",
        },
      };
      const prepared =
        preset === "questions"
          ? prepareQuestionBundle(workspace.store, task, null)
          : preparePostingDocumentBundle(workspace.store, task, null);
      assert.ok(!prepared.bundle.paths.includes("reference-conversation.md"));
      for (const file of [
        "QUESTION-INSTRUCTIONS.md",
        ...(preset === "questions" ? [] : ["DOCUMENT-INSTRUCTIONS.md"]),
      ]) {
        assert.doesNotMatch(
          readFileSync(path.join(prepared.cwd, file), "utf8"),
          /reference-conversation\.md/,
        );
      }
      assert.doesNotMatch(
        questionPrompt({ ...task, bundle: prepared.bundle }),
        /reference-conversation\.md/,
      );
      if (preset !== "questions")
        assert.doesNotMatch(
          postingDocumentPrompt({ ...task, bundle: prepared.bundle }),
          /reference-conversation\.md/,
        );
    }
    workspace.agent.readReferenceThread = async () => ({
      thread: {
        id: questionReferenceId,
        turns: [
          {
            id: "turn",
            status: "completed",
            items: [
              {
                id: "message",
                type: "userMessage",
                content: [{ type: "text", text: "Historical preferences" }],
              },
            ],
          },
        ],
      },
    });
    await workspace.get("/api/questions/context");
    const reference = workspace.store.get(
      "reference_context",
      questionReferenceId,
    );
    assert.ok(reference);
    const task = {
      id: randomUUID(),
      preset: "posting-resume",
      posting: {
        kind: "pasted",
        text: "Synthetic software role",
        hash: "posting",
      },
    };
    const prepared = preparePostingDocumentBundle(
      workspace.store,
      task,
      reference,
    );
    assert.ok(prepared.bundle.paths.includes("reference-conversation.md"));
    assert.match(
      readFileSync(path.join(prepared.cwd, "DOCUMENT-INSTRUCTIONS.md"), "utf8"),
      /reference-conversation\.md/,
    );
    assert.match(
      questionPrompt({ ...task, bundle: prepared.bundle }),
      /reference-conversation\.md/,
    );
  } finally {
    await workspace.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("an unconfigured reference never asks an agent to read a thread", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { mkdtempSync, rmSync } from "node:fs";
    import os from "node:os";
    import path from "node:path";
    import { openFixtureWorkspace } from ${JSON.stringify(new URL("./fixtures/http-workspace.js", import.meta.url).href)};
    import { sampleWorkspaceRoot } from ${JSON.stringify(new URL("./fixtures/sample-workspace.js", import.meta.url).href)};
    const data = mkdtempSync(path.join(os.tmpdir(), "unset-reference-"));
    const workspace = await openFixtureWorkspace(sampleWorkspaceRoot, data);
    let reads = 0;
    workspace.agent.readReferenceThread = async () => { reads++; throw new Error("Must not read a reference"); };
    try {
      const response = await workspace.get("/api/questions/context");
      assert.equal(response.status, 200);
      const context = await response.json();
      assert.equal(context.reference, null);
      assert.equal(context.referenceError, null);
      assert.equal(reads, 0);
    } finally { await workspace.close(); rmSync(data, { recursive: true, force: true }); }
  `;
  await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      env: { ...process.env, FIELDWORK_REFERENCE_THREAD_ID: "" },
      timeout: 30_000,
    },
  );
});
