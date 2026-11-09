import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { messageModelWorkspace } from "./fixtures/message-model-workspace.js";
import { initMessage } from "./fixtures/claude-code-fixture.js";
import { legacyTask, legacyBundle } from "./fixtures/legacy-records.js";

async function documentFixture() {
  const f = await messageModelWorkspace((_prompt, session) =>
    session.emit(initMessage(session)),
  );
  const id = randomUUID();
  const draft = path.join(f.codex.dataDir, "drafts", id);
  mkdirSync(draft, { recursive: true });
  const paths = ["cover_letter.txt", "DOCUMENT-INSTRUCTIONS.md"];
  for (const file of paths)
    writeFileSync(path.join(draft, file), `Captured ${file}`);
  const manifest = { paths, sourceHashes: {} };
  f.store.put("bundle", id, legacyBundle({ id, ...manifest }));
  f.store.put(
    "task",
    id,
    legacyTask({
      id,
      preset: "posting-cover-letter",
      prompt: "Original document request",
      overflowRequests: {
        prior: { kind: "independent", turnId: "prior-turn" },
      },
      manifest,
      posting: { text: "Saved role" },
    }),
  );
  const response = await f.post(`/api/tasks/${id}/start`, {
    model: "gpt-6-astra",
  });
  if (response.status !== 200) {
    const error = await response.text();
    await f.close();
    throw new Error(error);
  }
  await f.agent.interrupt(f.saved(id).threadId!);
  await setImmediate();
  return { ...f, id, draft };
}

test("carried document requests retain actual read/write tools and the same draft", async () => {
  const f = await documentFixture();
  let client: Client | undefined;
  try {
    const old = f.saved(f.id).threadId;
    const response = await f.post(`/api/tasks/${f.id}/message`, {
      model: "claude-fable-5-1",
      prompt: "Revise the saved draft",
      clientRequestId: "revise",
    });
    assert.equal(response.status, 200, await response.clone().text());
    const task = f.saved(f.id);
    assert.deepEqual(task.previousThreadIds, [old]);
    const session = f.claude.sessions[0];
    assert.equal(session.options.cwd, f.draft);
    assert.match(
      String(session.prompts[0].message.content),
      /DOCUMENT-INSTRUCTIONS.md/,
    );
    const server = session.options.mcpServers!
      .fieldwork as McpSdkServerConfigWithInstance;
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.instance.connect(serverTransport);
    client = new Client({ name: "carry-tools-test", version: "1" });
    await client.connect(clientTransport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(tools.sort(), [
      "read_job_search_source",
      "write_application_source",
    ]);
    const read = await client.callTool({
      name: "read_job_search_source",
      arguments: { path: "cover_letter.txt" },
    });
    const content = read.content as { type: string; text: string }[];
    const source = JSON.parse(content[0].text);
    assert.equal(source.text, "Captured cover_letter.txt");
    const written = await client.callTool({
      name: "write_application_source",
      arguments: {
        path: "cover_letter.txt",
        expectedHash: source.hash,
        content: "Revised through the carried task tool",
      },
    });
    assert.ok(!written.isError, JSON.stringify(written));
    assert.equal(
      readFileSync(path.join(f.draft, "cover_letter.txt"), "utf8"),
      "Revised through the carried task tool",
    );
    assert.equal(
      task.overflowRequests?.revise?.turnId,
      task.activeTurnId,
      "new document turn retains publication ownership",
    );
  } finally {
    await client?.close();
    await f.close();
  }
});

test("an active turn ignores a different message model and is steered without a new thread", async () => {
  const f = await messageModelWorkspace();
  try {
    const task = await f.create();
    const response = await f.post(`/api/tasks/${task.id}/message`, {
      model: "claude-fable-5-1",
      prompt: "Additional direction",
    });
    assert.equal(response.status, 200);
    assert.equal(f.claude.sessions.length, 0);
    assert.equal(f.saved(task.id).threadId, task.threadId);
    assert.equal(
      f.codex.messages.filter((message) => message.method === "turn/steer")
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("an unavailable saved default does not block an explicit model after disconnect", async () => {
  const f = await messageModelWorkspace();
  try {
    const task = await f.create();
    await f.complete(task, "Saved answer");
    f.store.put("settings", "main", {
      ...f.store.settings(),
      codexModels: { questions: "retired-model" },
    });
    f.store.put("task", task.id, {
      ...f.saved(task.id),
      status: "disconnected",
    });
    const response = await f.post(`/api/tasks/${task.id}/message`, {
      model: "gpt-6-sol",
      prompt: "Use an available model",
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(
      f.codex.messages
        .filter((message) => message.method === "turn/start")
        .at(-1).params.model,
      "gpt-6-sol",
    );
  } finally {
    await f.close();
  }
});

test("carry-over refuses excessive history without truncation or a partial new thread", async () => {
  const f = await messageModelWorkspace();
  try {
    const task = await f.create();
    await f.complete(task, "x".repeat(200000));
    const response = await f.post(`/api/tasks/${task.id}/message`, {
      model: "claude-opus-5-5",
      prompt: "Continue",
    });
    assert.equal(response.status, 413);
    assert.equal(f.claude.sessions.length, 0);
    assert.equal(f.saved(task.id).threadId, task.threadId);
    assert.equal(f.saved(task.id).messages.length, 2);
  } finally {
    await f.close();
  }
});

test("a provider availability error rejects its retained models without falling back", async () => {
  const f = await messageModelWorkspace();
  try {
    await f.agent.connect(true);
    f.agent.claude.close();
    const response = await f.post("/api/tasks", {
      preset: "questions",
      mode: "live",
      model: "claude-opus-5-5",
      prompt: "Unavailable Claude",
    });
    assert.equal(response.status, 400);
    assert.equal(f.claude.sessions.length, 0);
    assert.equal(
      f.codex.messages.filter((message) => message.method === "turn/start")
        .length,
      0,
    );
    assert.equal(f.store.list("task").length, 0);
  } finally {
    await f.close();
  }
});
