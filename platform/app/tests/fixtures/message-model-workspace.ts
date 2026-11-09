import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fixture } from "./codex-fixture.js";
import { fakeQuery, type Reply } from "./claude-code-fixture.js";
import { openFixtureWorkspace } from "./http-workspace.js";
import {
  questionReferenceId,
  referenceFromThread,
} from "../../server/question-context.js";
import type { Task } from "../../shared/types.js";

export async function messageModelWorkspace(reply?: Reply) {
  const codex = fixture({ uniqueThreadIds: true });
  const claude = fakeQuery({ reply });
  for (const file of [
    "AGENTS.md",
    "source_data/README.md",
    "source_data/resume.md",
    "source_data/github_evidence_dossier.md",
  ]) {
    mkdirSync(path.dirname(path.join(codex.root, file)), { recursive: true });
    writeFileSync(
      path.join(codex.root, file),
      `# Captured fixture evidence\n${file}\n`,
    );
  }
  const workspace = await openFixtureWorkspace(codex.root, codex.dataDir, {
    spawnProcess: codex.spawnProcess,
    inspectControllerProcess: () => ({
      state: "alive",
      identity: { startedAt: "2026-01-01T00:00:00Z", uid: 501 },
    }),
    claude: { query: claude.query, sessionMessages: async () => [] },
  });
  workspace.store.put(
    "reference_context",
    questionReferenceId,
    referenceFromThread({
      id: questionReferenceId,
      turns: [
        {
          items: [
            { type: "agentMessage", text: "Historical fixture preferences" },
          ],
        },
      ],
    }),
  );
  async function create(model?: string) {
    const response = await workspace.post("/api/tasks", {
      preset: "questions",
      mode: "live",
      prompt: "First question",
      model,
      postingText: "Fixture role and saved posting",
      context: {},
    });
    assert.equal(response.status, 200, await response.clone().text());
    const task: Task = await response.json();
    assert.ok(task.threadId, task.error ?? "No thread created");
    await setImmediate();
    return task;
  }
  const saved = (id: string) => {
    const task = workspace.store.get("task", id);
    assert.ok(task);
    return task;
  };
  async function complete(task: Task, answer: string) {
    assert.ok(task.threadId);
    const turn = codex.threads[task.threadId].turns.at(-1);
    turn.status = "completed";
    turn.items = [
      { id: `answer-${turn.id}`, type: "agentMessage", text: answer },
    ];
    codex.notify("turn/completed", { threadId: task.threadId, turn });
    await setImmediate();
  }
  return {
    ...workspace,
    codex,
    claude,
    create,
    saved,
    complete,
    async close() {
      await workspace.close();
      codex.cleanup();
    },
  };
}
