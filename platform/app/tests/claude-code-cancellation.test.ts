import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import {
  claudeFixture,
  initMessage,
  result,
} from "./fixtures/claude-code-fixture.js";

test("interrupted and replaced Claude turns cannot use their old MCP tools", async () => {
  let writes = 0;
  const fixture = claudeFixture({
    contextTool: () => ({ writes: ++writes }),
    reply: (_prompt, session) => session.emit(initMessage(session)),
  });
  const client = new Client({ name: "test", version: "1" });
  try {
    const started = await fixture.adapter.start({
      cwd: fixture.draft,
      prompt: "synthetic",
      purpose: "documents",
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = fixture.sessions[0].options.mcpServers
      ?.fieldwork as McpSdkServerConfigWithInstance;
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    const call = () =>
      client.callTool({
        name: "write_application_source",
        arguments: {
          path: "synthetic.md",
          expectedHash: "synthetic",
          content: "synthetic",
        },
      });
    assert.equal((await call()).isError, undefined);
    assert.equal(writes, 1);
    await fixture.adapter.interrupt(started.threadId);
    assert.equal((await call()).isError, true);
    fixture.sessions[0].emit(result([started.turnId]));
    await fixture.turnEnded();
    await fixture.adapter.send(started.threadId, "next turn");
    assert.equal((await call()).isError, true);
    assert.equal(writes, 1);
    assert.equal(
      fixture.events
        .filter((event) => event.method === "adapter/contextTool")
        .at(-1)?.turnId,
      started.turnId,
    );
  } finally {
    await client.close();
    fixture.cleanup();
  }
});
