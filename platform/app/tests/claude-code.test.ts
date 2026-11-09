import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { validateModelPreferences } from "../server/model-preferences.js";
import {
  answerEachPrompt,
  assistantText,
  claudeFixture,
  initMessage,
  result,
} from "./fixtures/claude-code-fixture.js";
import { claudeToolResultChars } from "../server/context-source-limits.js";

test("probe lists only Fable and Opus with high, xhigh and max effort", async () => {
  const f = claudeFixture();
  try {
    await f.adapter.connect(true);
    const status = f.adapter.status();
    assert.equal(status.available, true);
    assert.equal(status.auth, "Claude Max");
    assert.deepEqual(
      status.models.map((m) => [
        m.model,
        m.displayName,
        m.provider,
        m.isDefault,
        m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
      ]),
      [
        [
          "claude-fable-5-1",
          "Claude Fable 5.1",
          "claude",
          false,
          ["high", "xhigh", "max"],
        ],
        [
          "claude-opus-5-5",
          "Claude Opus 5.5",
          "claude",
          false,
          ["high", "xhigh", "max"],
        ],
      ],
    );
    await f.adapter.connect();
    assert.equal(f.probes(), 1, "the probe result is cached between refreshes");
  } finally {
    f.cleanup();
  }
});

test("API-key billing, other providers and missing sign-in are unavailable", async () => {
  for (const [account, reason] of [
    [
      { apiKeySource: "ANTHROPIC_API_KEY", apiProvider: "firstParty" },
      /API-key billing/,
    ],
    [{ apiProvider: "bedrock" }, /another API provider/],
    [{ apiProvider: "firstParty" }, /not signed in/],
  ] as const) {
    const f = claudeFixture({ account });
    try {
      await f.adapter.connect(true);
      assert.equal(f.adapter.status().available, false);
      assert.match(f.adapter.status().reason ?? "", reason);
      await assert.rejects(
        f.adapter.start({ prompt: "hi", cwd: f.draft, requestType: "job-fit" }),
        reason,
      );
    } finally {
      f.cleanup();
    }
  }
});

test("a turn starts an isolated session, emits Codex-shaped events and resumes for follow-ups", async () => {
  const f = claudeFixture({ effort: "xhigh" });
  const previousKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-ant-should-not-pass";
  try {
    const started = await f.adapter.start({
      prompt: "Draft it",
      cwd: f.draft,
      purpose: "documents",
      requestType: "posting-resume",
    });
    await f.turnEnded();
    assert.deepEqual(f.methods(), [
      "adapter/status",
      "adapter/threadCreated",
      "turn/started",
      "item/completed",
      "thread/tokenUsage/updated",
      "turn/completed",
    ]);
    const options = f.sessions[0].options;
    assert.equal(options.sessionId, started.threadId);
    assert.equal(options.resume, undefined);
    assert.equal(options.model, "claude-opus-5-5[1m]");
    assert.equal(options.effort, "xhigh");
    assert.deepEqual(options.tools, []);
    assert.equal(options.permissionMode, "dontAsk");
    assert.equal(options.permissionPrompts, "none");
    assert.deepEqual(options.settingSources, []);
    assert.equal(options.strictMcpConfig, true);
    assert.deepEqual(Object.keys(options.mcpServers ?? {}), ["fieldwork"]);
    assert.deepEqual(options.allowedTools, [
      "mcp__fieldwork__read_job_search_source",
      "mcp__fieldwork__write_application_source",
    ]);
    assert.equal(options.env?.ANTHROPIC_API_KEY, undefined);
    const completed = f.events.find((e) => e.method === "turn/completed")!;
    assert.equal(completed.params.turn.status, "completed");
    assert.deepEqual(completed.selection, {
      model: "claude-opus-5-5",
      effort: "xhigh",
    });
    assert.equal(
      f.events.find((e) => e.method === "thread/tokenUsage/updated")!.params
        .tokenUsage.total.totalTokens,
      105,
    );

    f.settings.model = "claude-fable-5-1";
    await f.adapter.send(started.threadId, "Revise it");
    await f.turnEnded(2);
    const second = f.sessions[1].options;
    assert.equal(second.resume, started.threadId);
    assert.equal(second.sessionId, undefined);
    assert.equal(second.model, "claude-fable-5-1[1m]");
    const registry = JSON.parse(
      readFileSync(path.join(f.dataDir, "claude-threads.json"), "utf8"),
    );
    const thread = registry.threads[started.threadId];
    assert.equal(thread.model, "claude-fable-5-1");
    assert.deepEqual(
      thread.turns.map((t: { status: string }) => t.status),
      ["completed", "completed"],
    );
    assert.equal(thread.usage.totalTokens, 210);
  } finally {
    if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousKey;
    f.cleanup();
  }
});

test("sessions that are billed by API key or broader than the policy never run", async () => {
  for (const [overrides, reason] of [
    [{ apiKeySource: "ANTHROPIC_API_KEY" }, /API-key billing/],
    [{ tools: ["Bash"] }, /broader or unverifiable tool set/],
    [{ model: "claude-sonnet-5-5[1m]" }, /did not confirm the selected model/],
    [{ permissionMode: "bypassPermissions" }, /permission mode/],
  ] as const) {
    const f = claudeFixture({
      reply: (prompt, session) => {
        session.emit(initMessage(session, overrides));
        session.emit(assistantText("never", "should not be published"));
        session.emit(result([prompt.uuid!]));
      },
    });
    try {
      const startedThread = new Promise<string>((resolve) => {
        const timer = setInterval(() => {
          const created = f.events.find(
            (e) => e.method === "adapter/threadCreated",
          );
          if (created) {
            clearInterval(timer);
            resolve(created.threadId);
          }
        }, 2);
      });
      await assert.rejects(
        f.adapter.start({ prompt: "hi", cwd: f.draft, purpose: "questions" }),
        reason,
      );
      const threadId = await startedThread;
      assert.ok(!f.methods().includes("turn/started"));
      assert.ok(!f.methods().includes("item/completed"));
      const view = await f.adapter.read(threadId);
      assert.equal(view.thread.turns[0].status, "failed");
      assert.equal(f.adapter.status().threads[0].activeTurnId, undefined);
    } finally {
      f.cleanup();
    }
  }
});

test("steering joins the active turn, which ends only after every message is answered", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const f = claudeFixture({
    reply: async (prompt, session) => {
      if (session.prompts.length === 1) {
        session.emit(initMessage(session));
        await gate;
        session.emit(assistantText("first", "partial"));
        session.emit(result([prompt.uuid!]));
      } else {
        session.emit(assistantText("second", "steered"));
        session.emit(result([prompt.uuid!]));
      }
    },
  });
  try {
    const started = await f.adapter.start({ prompt: "Go", cwd: f.draft });
    const steer = await f.adapter.steer(started.threadId, "Also this");
    assert.equal(steer.turnId, started.turnId);
    release();
    await f.turnEnded();
    const completed = f.events.filter((e) => e.method === "turn/completed");
    assert.equal(completed.length, 1);
    assert.deepEqual(
      completed[0].params.turn.items.map((i: { text: string }) => i.text),
      ["partial", "steered"],
    );
    assert.equal(f.sessions[0].prompts.length, 2);
    await assert.rejects(
      f.adapter.steer(started.threadId, "late"),
      /no active turn/,
    );
  } finally {
    f.cleanup();
  }
});

test("interrupting ends the turn as interrupted even when the process exits nonzero", async () => {
  const f = claudeFixture({
    reply: (prompt, session) => {
      session.emit(initMessage(session));
      session.emit(assistantText("p", "partial answer"));
      const timer = setInterval(() => {
        if (!session.interrupted) return;
        clearInterval(timer);
        session.emit(
          result([prompt.uuid!], {
            subtype: "error_during_execution",
            is_error: true,
            terminal_reason: "aborted_streaming",
            errors: ["[ede_diagnostic] aborted"],
          }),
        );
        session.end(new Error("Claude Code process exited with code 1"));
      }, 2);
    },
  });
  try {
    const started = await f.adapter.start({
      prompt: "Long task",
      cwd: f.draft,
    });
    assert.deepEqual(await f.adapter.interrupt(started.threadId), {
      interrupted: true,
      turnId: started.turnId,
    });
    await f.turnEnded();
    const completed = f.events.find((e) => e.method === "turn/completed")!;
    assert.equal(completed.params.turn.status, "interrupted");
    assert.equal(completed.params.turn.error, null);
    assert.deepEqual(await f.adapter.interrupt(started.threadId), {
      interrupted: false,
      reason: "No active turn.",
    });
  } finally {
    f.cleanup();
  }
});

test("a process that exits mid-turn fails the turn with its diagnostic", async () => {
  const f = claudeFixture({
    reply: (_prompt, session) => {
      session.emit(initMessage(session));
      session.options.stderr?.("fatal: socat not installed\n");
      session.end(new Error("Claude Code process exited with code 1"));
    },
  });
  try {
    await f.adapter.start({ prompt: "Go", cwd: f.draft });
    await f.turnEnded();
    const completed = f.events.find((e) => e.method === "turn/completed")!;
    assert.equal(completed.params.turn.status, "failed");
    assert.match(
      completed.params.turn.error.message,
      /exited with code 1.*socat not installed/,
    );
  } finally {
    f.cleanup();
  }
});

test("ordinary tasks run sandboxed tools and route other permission prompts to the user", async () => {
  const decisions: unknown[] = [];
  const f = claudeFixture({
    reply: async (prompt, session) => {
      session.emit(initMessage(session));
      const ask = session.options.canUseTool!;
      const signal = new AbortController().signal;
      decisions.push(
        await ask(
          "Read",
          { file_path: "notes.md" },
          { signal, toolUseID: "t0", requestId: "r0" },
        ),
      );
      decisions.push(
        await ask(
          "Bash",
          { command: "curl example.com" },
          {
            signal,
            toolUseID: "t1",
            requestId: "r1",
            title: "Run curl outside the sandbox?",
          },
        ),
      );
      decisions.push(
        await ask(
          "Write",
          { file_path: "/etc/x" },
          { signal, toolUseID: "t2", requestId: "r2" },
        ),
      );
      session.emit(result([prompt.uuid!]));
    },
  });
  try {
    const answers = ["accept", "cancel"];
    const responder = setInterval(() => {
      const pending = f.adapter.status().pendingRequests[0];
      if (!pending) return;
      f.adapter.respond(pending.requestId, { decision: answers.shift() });
    }, 2);
    await f.adapter.start({
      prompt: "Go",
      cwd: f.draft,
      requestType: "job-fit",
    });
    await f.turnEnded();
    clearInterval(responder);
    const options = f.sessions[0].options;
    assert.equal(options.permissionMode, "acceptEdits");
    assert.deepEqual(options.allowedTools, []);
    assert.equal(options.sandbox?.enabled, true);
    assert.equal(options.sandbox?.allowUnsandboxedCommands, false);
    assert.deepEqual(options.sandbox?.network?.allowedDomains, []);
    assert.deepEqual(decisions, [
      { behavior: "allow" },
      { behavior: "allow" },
      {
        behavior: "deny",
        message: "The user cancelled this request.",
        interrupt: true,
      },
    ]);
    const requests = f.events.filter((e) => e.method === "adapter/request");
    assert.deepEqual(
      requests.map((e) => [
        e.request.method,
        e.request.params.command ?? e.request.params.path,
      ]),
      [
        ["item/commandExecution/requestApproval", "curl example.com"],
        ["item/fileChange/requestApproval", "/etc/x"],
      ],
    );
    assert.equal(
      requests[0].request.params.reason,
      "Run curl outside the sandbox?",
    );
    assert.throws(
      () =>
        f.adapter.respond(requests[0].request.requestId, {
          decision: "accept",
        }),
      /no longer exists/,
    );
  } finally {
    f.cleanup();
  }
});

test("Fieldwork tools are served over MCP and report each call", async () => {
  const calls: unknown[] = [];
  let toolResult: unknown;
  const f = claudeFixture({
    contextTool: (threadId, tool, args) => {
      calls.push([threadId, tool, args]);
      if (args.path === "missing.md") throw new Error("Not in the manifest");
      return { text: "evidence", hash: "h" };
    },
    reply: async (prompt, session) => {
      session.emit(initMessage(session));
      const server = session.options.mcpServers!
        .fieldwork as McpSdkServerConfigWithInstance;
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverTransport);
      const client = new Client({ name: "test", version: "1" });
      await client.connect(clientTransport);
      const listed = await client.listTools();
      toolResult = {
        tools: listed.tools.map((t) => t.name),
        // Whole sources must stay inline: Claude Code files larger results away.
        maxResultChars: listed.tools.map(
          (t) => t._meta?.["anthropic/maxResultSizeChars"],
        ),
        ok: await client.callTool({
          name: "read_job_search_source",
          arguments: { path: "a.md" },
        }),
        failed: await client.callTool({
          name: "read_job_search_source",
          arguments: { path: "missing.md" },
        }),
        unknown: await client.callTool({
          name: "write_application_source",
          arguments: {},
        }),
      };
      await client.close();
      session.emit(result([prompt.uuid!]));
    },
  });
  try {
    const started = await f.adapter.start({
      prompt: "Go",
      cwd: f.draft,
      purpose: "questions",
    });
    await f.turnEnded();
    assert.deepEqual(f.sessions[0].options.tools, ["WebSearch"]);
    assert.deepEqual(toolResult, {
      tools: ["read_job_search_source"],
      maxResultChars: [claudeToolResultChars],
      ok: {
        content: [{ type: "text", text: '{"text":"evidence","hash":"h"}' }],
      },
      failed: {
        isError: true,
        content: [{ type: "text", text: "Not in the manifest" }],
      },
      unknown: {
        isError: true,
        content: [{ type: "text", text: "This task has no such tool." }],
      },
    });
    assert.deepEqual(
      calls.map((c) => (c as unknown[])[0]),
      [started.threadId, started.threadId],
    );
    assert.deepEqual(
      f.events
        .filter((e) => e.method === "adapter/contextTool")
        .map((e) => [e.params.path, e.params.success]),
      [
        ["a.md", true],
        ["missing.md", false],
      ],
    );
  } finally {
    f.cleanup();
  }
});

test("after a restart, a running turn is marked interrupted and the transcript rebuilds the thread", async () => {
  const first = claudeFixture({
    reply: (prompt, session) => {
      session.emit(initMessage(session));
      session.emit(assistantText("kept", "Before restart"));
    },
  });
  const started = await first.adapter.start({ prompt: "Go", cwd: first.draft });
  // Simulate the process dying with the app: no close(), no turn completion.
  const second = claudeFixture({
    dir: first.root,
    transcript: [
      {
        type: "user",
        uuid: started.turnId,
        message: { content: "Go" },
        parent_tool_use_id: null,
      },
      {
        type: "assistant",
        uuid: "kept",
        message: {
          model: "claude-opus-5-5",
          content: [{ type: "text", text: "Before restart" }],
        },
        parent_tool_use_id: null,
      },
      {
        type: "assistant",
        uuid: "sub",
        message: { content: [{ type: "text", text: "subagent" }] },
        parent_tool_use_id: "toolu",
      },
      {
        type: "assistant",
        uuid: "syn",
        message: {
          model: "<synthetic>",
          content: [{ type: "text", text: "No response requested." }],
        },
        parent_tool_use_id: null,
      },
    ],
  });
  try {
    assert.equal(
      second.adapter.status().threads[0].activeTurnId,
      started.turnId,
    );
    const resumed = await second.adapter.resume(started.threadId);
    assert.deepEqual(resumed.thread.turns, [
      {
        id: started.turnId,
        status: "interrupted",
        items: [{ type: "agentMessage", id: "kept:0", text: "Before restart" }],
        error: {
          message:
            "Fieldwork restarted during this turn. It was not restarted automatically.",
        },
        completedAt: resumed.thread.turns[0].completedAt,
      },
    ]);
    assert.ok(second.methods().includes("adapter/threadResumed"));
    await second.adapter.send(started.threadId, "Continue");
    await second.turnEnded();
    assert.equal(second.sessions[0].options.resume, started.threadId);
  } finally {
    first.adapter.close();
    second.cleanup();
  }
});

test("a Claude thread keeps its own model when Settings choose another provider", async () => {
  const f = claudeFixture({ reply: answerEachPrompt });
  try {
    const started = await f.adapter.start({ prompt: "Go", cwd: f.draft });
    await f.turnEnded();
    f.settings.model = "gpt-6-astra";
    f.settings.effort = "ultra";
    await f.adapter.send(started.threadId, "Again");
    await f.turnEnded(2);
    assert.equal(f.sessions[1].options.model, "claude-opus-5-5[1m]");
    assert.equal(f.sessions[1].options.effort, "high");
    f.settings.model = "claude-opus-5-5";
    await assert.rejects(
      f.adapter.send(started.threadId, "Max?"),
      /does not support reasoning effort “ultra”/,
    );
  } finally {
    f.cleanup();
  }
});

test("model settings accept Claude choices only while Claude Code is available", () => {
  const catalog = {
    models: [
      {
        id: "gpt-6-astra",
        model: "gpt-6-astra",
        displayName: "GPT-6-Astra",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [{ reasoningEffort: "high" }],
      },
      {
        id: "claude-opus-5-5",
        model: "claude-opus-5-5",
        displayName: "Claude Opus 5.5",
        provider: "claude" as const,
        isDefault: false,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "high" },
          { reasoningEffort: "max" },
        ],
      },
    ],
    refreshedAt: null,
    refreshing: false,
    error: null,
  };
  const choice = { questions: "claude-opus-5-5" };
  assert.deepEqual(
    validateModelPreferences(choice, { questions: "max" }, {}, catalog),
    { codexModels: choice, codexEfforts: { questions: "max" } },
  );
  assert.throws(
    () =>
      validateModelPreferences(
        choice,
        {},
        {},
        {
          ...catalog,
          providerErrors: { claude: "Claude Code is not signed in." },
        },
      ),
    /Choose an available model/,
  );
  // A Codex catalog error does not block a Claude choice, and vice versa.
  assert.ok(
    validateModelPreferences(
      choice,
      {},
      {},
      { ...catalog, error: "Codex offline" },
    ),
  );
  assert.throws(
    () => validateModelPreferences(choice, { questions: "ultra" }, {}, catalog),
    /Choose an available model/,
  );
});
