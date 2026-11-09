import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentRouter } from "../server/agent-router.js";
import { fakeQuery } from "./fixtures/claude-code-fixture.js";

test("router starts a saved Claude choice without connecting Codex and retains thread ownership", async () => {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), "agent-router-")),
  );
  const dataDir = path.join(root, "data");
  const cwd = path.join(dataDir, "drafts", "one");
  mkdirSync(cwd, { recursive: true });
  const fake = fakeQuery();
  let model = "claude-opus-5-5";
  let completed = 0;
  const router = new AgentRouter({
    root,
    dataDir,
    modelPreference: () => model,
    spawnProcess: () => {
      throw new Error("Codex must not be started");
    },
    claude: { query: fake.query, sessionMessages: async () => [] },
    onEvent: (event) => {
      if (event.method === "turn/completed") completed++;
    },
  });
  try {
    const first = await router.start({
      cwd,
      prompt: "hello",
      purpose: "questions",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, 1);
    assert.equal(router.status().providers.claude.available, true);
    assert.equal(router.status().providers.codex.connected, false);
    assert.equal(router.status().available, true);
    assert.equal(router.status().threads.length, 1);
    assert.equal(
      router
        .modelCatalogStatus()
        .models.filter((entry) => entry.provider === "claude").length,
      2,
    );
    model = "gpt-6-astra";
    await router.resume(first.threadId);
    await router.send(first.threadId, "continue");
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, 2);
    assert.equal(fake.sessions[1].options.resume, first.threadId);
    assert.equal(fake.sessions[1].options.model, "claude-opus-5-5[1m]");
    assert.equal((await router.read(first.threadId)).thread.id, first.threadId);
  } finally {
    router.close();
    rmSync(root, { recursive: true, force: true });
  }
});
