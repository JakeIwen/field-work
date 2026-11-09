import test from "node:test";
import assert from "node:assert/strict";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { LiveActivityTracker } from "../server/claude-code/live-activity.js";
import {
  claudeFixture,
  initMessage,
  result,
  streamEvent,
  systemMessage,
} from "./fixtures/claude-code-fixture.js";

/** A clock the test advances by hand: the tracker reads time only through it. */
function clock() {
  let tick = 0;
  return {
    advance: (seconds = 1) => (tick += seconds),
    now: () => new Date(Date.UTC(2026, 10, 6, 10, 0, tick)).toISOString(),
  };
}
const raw = (message: Record<string, unknown>) =>
  message as unknown as SDKMessage;
const blockStart = (type: string) =>
  raw(
    streamEvent({
      type: "content_block_start",
      index: 0,
      content_block: { type },
    }),
  );
const delta = (value: Record<string, unknown>) =>
  raw(streamEvent({ type: "content_block_delta", index: 0, delta: value }));

test("nothing is reported before the first signal", () => {
  const tracker = new LiveActivityTracker(clock().now);
  assert.equal(tracker.snapshot(), undefined);
});

test("a thinking block, then text and tool input, move the state and count output", () => {
  const time = clock();
  const tracker = new LiveActivityTracker(time.now);
  tracker.observe(raw(initMessage({ options: {} } as never)));
  assert.equal(tracker.snapshot()?.state, "requesting");

  time.advance(5);
  tracker.observe(blockStart("thinking"));
  const thinking = tracker.snapshot();
  assert.equal(thinking?.state, "thinking");
  assert.equal(thinking?.since, time.now());

  time.advance(60);
  tracker.observe(
    raw(systemMessage("thinking_tokens", { estimated_tokens: 900 })),
  );
  assert.equal(tracker.snapshot()?.thinkingTokens, 900);
  assert.equal(
    tracker.snapshot()?.since,
    thinking?.since,
    "still the same state",
  );

  time.advance(10);
  tracker.observe(blockStart("text"));
  tracker.observe(delta({ type: "text_delta", text: "Hello" }));
  assert.deepEqual(
    [tracker.snapshot()?.state, tracker.snapshot()?.outputChars],
    ["writing", 5],
  );

  time.advance(2);
  tracker.observe(blockStart("tool_use"));
  tracker.observe(
    delta({ type: "input_json_delta", partial_json: '{"content":"' }),
  );
  tracker.observe(delta({ type: "input_json_delta", partial_json: "abc" }));
  const tool = tracker.snapshot();
  assert.equal(tool?.state, "tool");
  assert.equal(tool?.outputChars, 5 + 12 + 3);
  assert.equal(tool?.lastSignalAt, time.now());
});

test("a returned tool result starts a new request and drops the thinking estimate", () => {
  const time = clock();
  const tracker = new LiveActivityTracker(time.now);
  tracker.observe(
    raw(systemMessage("thinking_tokens", { estimated_tokens: 40 })),
  );
  tracker.observe(blockStart("tool_use"));
  time.advance(3);
  tracker.toolResultReturned();
  const snapshot = tracker.snapshot();
  assert.equal(snapshot?.state, "requesting");
  assert.equal(snapshot?.since, time.now());
  assert.equal(snapshot?.thinkingTokens, undefined);
});

test("retries and compaction are shown and clear themselves", () => {
  const time = clock();
  const tracker = new LiveActivityTracker(time.now);
  tracker.observe(
    raw(systemMessage("api_retry", { attempt: 2, retry_delay_ms: 4000 })),
  );
  assert.deepEqual(tracker.snapshot()?.retry, { attempt: 2, delayMs: 4000 });
  assert.equal(tracker.snapshot()?.state, "retrying");
  tracker.observe(blockStart("text"));
  assert.equal(tracker.snapshot()?.state, "writing");
  assert.equal(tracker.snapshot()?.retry, undefined);

  tracker.observe(raw(systemMessage("status", { status: "compacting" })));
  assert.equal(tracker.snapshot()?.state, "compacting");
  tracker.observe(raw(systemMessage("status", { status: null })));
  assert.equal(tracker.snapshot()?.state, "requesting");
  tracker.observe(raw(systemMessage("status", { status: "requesting" })));
  assert.equal(tracker.snapshot()?.state, "requesting");
});

test("every message refreshes lastSignalAt, a subagent's output is not counted", () => {
  const time = clock();
  const tracker = new LiveActivityTracker(time.now);
  tracker.observe(blockStart("text"));
  time.advance(30);
  tracker.observe(
    raw(
      streamEvent(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "ignored" },
        },
        { parent_tool_use_id: "toolu_1" },
      ),
    ),
  );
  const snapshot = tracker.snapshot();
  assert.equal(snapshot?.lastSignalAt, time.now());
  assert.equal(snapshot?.outputChars, 0);
  time.advance(1);
  tracker.observe(
    raw({ type: "assistant", uuid: "a", message: { content: [] } }),
  );
  assert.equal(tracker.snapshot()?.lastSignalAt, time.now());
});

test("agent.liveActivity follows a running turn and ends with it", async () => {
  const f = claudeFixture({
    reply: (_prompt, session) => session.emit(initMessage(session)),
  });
  try {
    const started = await f.adapter.start({ prompt: "Go", cwd: f.draft });
    const session = f.sessions[0];
    const waitFor = async (check: () => boolean) => {
      for (let i = 0; i < 200 && !check(); i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.ok(check(), "the tracker saw the scripted messages");
    };
    // The init message is already a signal, observed before turn.ts filters it.
    await waitFor(() => f.adapter.liveActivity(started.threadId) !== undefined);
    assert.equal(f.adapter.liveActivity(started.threadId)?.state, "requesting");

    session.emit(
      streamEvent({
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      }),
    );
    session.emit(systemMessage("thinking_tokens", { estimated_tokens: 12 }));
    await waitFor(
      () => f.adapter.liveActivity(started.threadId)?.thinkingTokens === 12,
    );
    assert.equal(f.adapter.liveActivity(started.threadId)?.state, "thinking");

    session.emit(
      streamEvent({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use" },
      }),
    );
    session.emit(
      streamEvent({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"a":1}' },
      }),
    );
    await waitFor(
      () => f.adapter.liveActivity(started.threadId)?.outputChars === 7,
    );
    assert.equal(f.adapter.liveActivity(started.threadId)?.state, "tool");

    session.emit(result([session.prompts[0].uuid!]));
    await f.turnEnded();
    assert.equal(f.adapter.liveActivity(started.threadId), undefined);
    assert.equal(f.adapter.liveActivity("unknown-thread"), undefined);
  } finally {
    f.cleanup();
  }
});

test("a Fieldwork tool result returns the live turn to requesting", async () => {
  let toolDone: Promise<unknown> = Promise.resolve();
  const f = claudeFixture({
    contextTool: () => ({ text: "evidence" }),
    reply: async (_prompt, session) => {
      session.emit(initMessage(session));
      const server = session.options.mcpServers!
        .fieldwork as McpSdkServerConfigWithInstance;
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      await server.instance.connect(serverTransport);
      const client = new Client({ name: "test", version: "1" });
      await client.connect(clientTransport);
      session.emit(
        streamEvent({
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use" },
        }),
      );
      toolDone = client.callTool({
        name: "read_job_search_source",
        arguments: { path: "a.md" },
      });
    },
  });
  try {
    const started = await f.adapter.start({
      prompt: "Go",
      cwd: f.draft,
      purpose: "documents",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await toolDone;
    assert.equal(f.adapter.liveActivity(started.threadId)?.state, "requesting");
  } finally {
    f.cleanup();
  }
});
