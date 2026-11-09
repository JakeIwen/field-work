import assert from "node:assert/strict";
import test from "node:test";
import {
  codexErrorMessage,
  codexProperty,
  codexQuestionIds,
  codexRecord,
  codexToolContent,
  isCodexAnswer,
  publicCodexErrorMessage,
  publicCodexValue,
  readCodexAccount,
  readCodexConfig,
  readCodexEvent,
  readCodexInitialize,
  readCodexMessage,
  readCodexReferenceReply,
  readCodexThreadReply,
  readCodexTurnReply,
} from "../server/codex-protocol.js";
import { fixture } from "./fixtures/codex-fixture.js";

const turn = {
  id: "turn-1",
  status: "completed",
  items: [
    {
      type: "userMessage",
      id: "u1",
      content: [{ type: "text", text: "hello" }],
    },
    { type: "agentMessage", id: "a1", text: "reply" },
    { type: "reasoning", id: "r1", summary: [], content: ["hidden"] },
    { type: "futureItem", extension: { retained: true } },
  ],
  error: null,
};
const thread = {
  id: "thread-1",
  cwd: "/draft",
  name: null,
  updatedAt: 1,
  turns: [turn],
  extension: { retained: true },
};

test("protocol readers retain conformant replies and opaque future fields", () => {
  const value = { thread, sandbox: { type: "readOnly" }, model: "model" };
  assert.deepEqual(readCodexThreadReply(value), value);
  assert.equal(readCodexThreadReply(value).thread, thread);
  assert.deepEqual(readCodexTurnReply({ turn }), { turn });
  assert.equal(readCodexTurnReply({ turn }).turn, turn);
  assert.deepEqual(turn.items[2].content, ["hidden"]);
});

test("notification readers retain raw params and the original ID precedence", () => {
  for (const id of ["request", 0, 7]) {
    const params = {
      threadId: "direct",
      thread: { id: "nested" },
      turnId: "direct-turn",
      turn,
      tool: "read_job_search_source",
      arguments: ["opaque", null],
      extra: { retained: true },
    };
    const message = readCodexMessage({ id, method: "item/tool/call", params });
    assert.equal(message.id, id);
    assert.equal(message.params.raw, params);
    assert.equal(message.params.arguments, params.arguments);
    assert.equal(message.params.threadId || message.params.thread.id, "direct");
    assert.equal(
      message.params.turnId || message.params.turn.id,
      "direct-turn",
    );
  }
  const fallback = readCodexMessage({
    method: "turn/started",
    params: { threadId: "", thread: { id: "nested" }, turnId: "", turn },
  }).params;
  assert.equal(fallback.threadId || fallback.thread.id, "nested");
  assert.equal(fallback.turnId || fallback.turn.id, "turn-1");
});

test("RPC envelopes keep results and error details opaque", () => {
  const result = { arbitrary: [null, false, 1, "text"] };
  const error = { code: -32000, message: "denied", data: { retained: true } };
  assert.equal(readCodexMessage({ id: "fieldwork-1", result }).result, result);
  assert.equal(readCodexMessage({ id: "fieldwork-1", error }).error, error);
  assert.equal(codexProperty(error, "code"), -32000);
  assert.equal(codexErrorMessage(error), "denied");
});

test("missing and malformed notification fields follow missing-field fallbacks", () => {
  for (const params of [undefined, null, false, 0, "invalid", []]) {
    const value = readCodexMessage({ method: "warning", params });
    assert.equal(value.params.threadId || value.params.thread.id, undefined);
    assert.equal(value.params.turnId || value.params.turn.id, undefined);
  }
  const value = readCodexMessage({
    id: { invalid: true },
    method: 12,
    params: {
      threadId: 1,
      thread: { id: "fallback" },
      turnId: false,
      turn: { id: 123 },
    },
  });
  assert.equal(value.id, undefined);
  assert.equal(value.method, undefined);
  assert.equal(value.params.threadId || value.params.thread.id, "fallback");
  assert.equal(value.params.turnId || value.params.turn.id, undefined);
  assert.deepEqual(readCodexMessage(null).params.raw, {});
});

test("initialize reader preserves userAgent/version truthy fallback order", () => {
  assert.equal(
    readCodexInitialize({ userAgent: "cli", version: "legacy" }),
    "cli",
  );
  assert.equal(
    readCodexInitialize({ userAgent: "", version: "legacy" }),
    "legacy",
  );
  assert.equal(readCodexInitialize({ version: "legacy" }), "legacy");
  assert.equal(
    readCodexInitialize({ userAgent: 7, version: "legacy" }),
    "legacy",
  );
  assert.equal(readCodexInitialize({ userAgent: true, version: [] }), null);
  assert.equal(readCodexInitialize(null), null);
});

test("account and config readers preserve sign-out and nullish server fallbacks", () => {
  for (const type of ["chatgpt", "apiKey", "amazonBedrock", "future-mode"]) {
    assert.equal(readCodexAccount({ account: { type } }), type);
  }
  for (const value of [
    {},
    null,
    { account: null },
    { account: { type: "" } },
    { account: { type: 1 } },
  ]) {
    assert.equal(readCodexAccount(value), "signed_out");
  }
  assert.deepEqual(
    readCodexConfig({ config: { mcp_servers: { first: {}, second: {} } } }),
    ["first", "second"],
  );
  assert.deepEqual(readCodexConfig({ config: { mcp_servers: null } }), []);
  assert.deepEqual(readCodexConfig({ config: { mcp_servers: "ab" } }), [
    "0",
    "1",
  ]);
  assert.deepEqual(readCodexConfig(null), []);
});

test("public events preserve absent keys, nullable status and full parameters", () => {
  for (const value of [
    { method: "adapter/status", reason: null, available: true },
    {
      method: "turn/completed",
      threadId: "thread-1",
      params: { turn, extension: 7 },
    },
    { method: "thread/started", params: { thread } },
    {
      method: "adapter/request",
      request: {
        id: 0,
        requestId: "0",
        method: "item/tool/requestUserInput",
        params: {},
      },
    },
  ]) {
    assert.equal(readCodexEvent(value), value);
  }
});

test("malformed public event fields do not masquerade as strings", () => {
  const event = readCodexEvent({
    method: "turn/completed",
    threadId: 4,
    turnId: true,
    at: 7,
    params: { turn: { id: 123, status: "completed" }, clientRequestId: [] },
  });
  assert.equal(event.threadId, undefined);
  assert.equal(event.turnId, undefined);
  assert.equal(event.at, undefined);
  assert.equal(event.params?.turn?.id, "");
  assert.equal(event.params?.clientRequestId, undefined);
});

test("required reply fields use empty identities without inventing IDs", () => {
  const reply = readCodexThreadReply({
    thread: { id: 123, cwd: false, turns: "bad" },
  });
  assert.equal(reply.thread.id, "");
  assert.equal(reply.thread.cwd, undefined);
  assert.deepEqual(reply.thread.turns, []);
  assert.equal(
    readCodexTurnReply({ turn: { id: null, status: 1 } }).turn.id,
    "",
  );
  assert.equal(
    readCodexTurnReply({ turn: { status: 1 } }).turn.status,
    undefined,
  );
});

test("question answers retain the existing array validation", () => {
  assert.deepEqual(
    [...codexQuestionIds({ questions: [{ id: "a" }, { id: 7 }, {}] })],
    ["a", 7, undefined],
  );
  assert.deepEqual([...codexQuestionIds({})], []);
  assert.deepEqual([...codexQuestionIds({ questions: "invalid" })], []);
  for (const value of [
    { answers: [] },
    { answers: ["one", "two"], extra: true },
  ])
    assert.equal(isCodexAnswer(value), true);
  for (const value of [
    null,
    {},
    { answers: "one" },
    { answers: [1] },
    { answers: [null] },
  ])
    assert.equal(isCodexAnswer(value), false);
});

test("tool content is the exact JSON text", () => {
  const result = { previewImage: "data:image/png;base64,AA==", extra: true };
  assert.deepEqual(codexToolContent(result), [
    { type: "inputText", text: JSON.stringify(result) },
  ]);
  assert.deepEqual(codexToolContent(undefined), [
    { type: "inputText", text: undefined },
  ]);
});

test("redaction keeps public values and reference evidence while removing secrets", () => {
  const sanitized = publicCodexValue({
    thread,
    token: "Bearer secret",
    config: { private: true },
  });
  assert.deepEqual(sanitized, {
    thread: {
      ...thread,
      turns: [
        {
          ...turn,
          items: turn.items.filter((item) => item.type !== "reasoning"),
        },
      ],
    },
    token: "Bearer [redacted]",
  });
  assert.deepEqual(
    readCodexReferenceReply({ thread }).thread.turns[0].items,
    turn.items.filter((item) => item.type !== "reasoning"),
  );
  assert.equal(
    publicCodexErrorMessage(new Error("Bearer private")),
    "Bearer [redacted]",
  );
  assert.equal(publicCodexErrorMessage({ message: 7 }), undefined);
  assert.equal(codexErrorMessage("not an error object"), undefined);
  assert.equal(codexProperty(null, "message"), undefined);
  assert.deepEqual(codexRecord(false), {});
});

test("numeric notification turn IDs are treated as missing, not coerced", async () => {
  const f = fixture();
  try {
    const started = await f.adapter.start({ cwd: f.draft, prompt: "test" });
    f.notify("turn/started", {
      threadId: started.threadId,
      turn: { id: 123, status: "inProgress" },
    });
    assert.equal(f.adapter.status().threads[0].activeTurnId, undefined);
    assert.deepEqual(await f.adapter.interrupt(started.threadId), {
      interrupted: false,
      reason: "No active turn.",
    });
  } finally {
    f.cleanup();
  }
});

test("invalid thread-start identities fail without creating a managed thread or starting a turn", async () => {
  const f = fixture({
    response: (value: unknown) => {
      const raw = codexRecord(value);
      return { ...raw, thread: { ...codexRecord(raw.thread), id: 123 } };
    },
  });
  try {
    await assert.rejects(
      f.adapter.start({ cwd: f.draft, prompt: "test" }),
      /did not return a thread id/,
    );
    assert.equal(f.adapter.status().threads.length, 0);
    assert.equal(
      f.messages.some(
        (message: { method: string }) => message.method === "turn/start",
      ),
      false,
    );
  } finally {
    f.cleanup();
  }
});
