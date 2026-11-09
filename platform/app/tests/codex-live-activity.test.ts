import test from "node:test";
import assert from "node:assert/strict";
import { CodexLiveActivityTracker } from "../server/codex-live-activity.js";
import { readCodexMessage } from "../server/codex-protocol.js";
import { fixture } from "./fixtures/codex-fixture.js";

function clock() {
  let tick = 0;
  return {
    advance: (seconds = 1) => (tick += seconds),
    now: () => new Date(Date.UTC(2026, 10, 6, 10, 0, tick)).toISOString(),
  };
}
const T = "thread-1";

test("item types decide the state and every notification is a signal", () => {
  const time = clock();
  const tracker = new CodexLiveActivityTracker(time.now);
  assert.equal(tracker.snapshot(T), undefined);

  tracker.observe({ method: "turn/started", threadId: T });
  assert.equal(tracker.snapshot(T)?.state, "requesting");

  time.advance(2);
  tracker.observe({
    method: "item/started",
    threadId: T,
    itemType: "reasoning",
  });
  const thinking = tracker.snapshot(T);
  assert.equal(thinking?.state, "thinking");
  assert.equal(thinking?.since, time.now());

  time.advance(40);
  tracker.observe({ method: "item/reasoning/summaryTextDelta", threadId: T });
  assert.equal(tracker.snapshot(T)?.since, thinking?.since);
  assert.equal(tracker.snapshot(T)?.lastSignalAt, time.now());

  time.advance(1);
  tracker.observe({
    method: "item/started",
    threadId: T,
    itemType: "agentMessage",
  });
  tracker.observe({
    method: "item/agentMessage/delta",
    threadId: T,
    deltaChars: 7,
  });
  tracker.observe({
    method: "item/agentMessage/delta",
    threadId: T,
    deltaChars: 5,
  });
  assert.deepEqual(
    [tracker.snapshot(T)?.state, tracker.snapshot(T)?.outputChars],
    ["writing", 12],
  );

  for (const itemType of [
    "commandExecution",
    "fileChange",
    "toolCall",
    "webSearch",
  ]) {
    tracker.observe({ method: "item/started", threadId: T, itemType });
    assert.equal(tracker.snapshot(T)?.state, "tool", itemType);
  }
  tracker.observe({ method: "item/commandExecution/outputDelta", threadId: T });
  assert.equal(tracker.snapshot(T)?.state, "tool");

  tracker.observe({
    method: "item/completed",
    threadId: T,
    itemType: "commandExecution",
  });
  assert.equal(tracker.snapshot(T)?.state, "requesting");
});

test("a turn's end clears its view, and bookkeeping alone starts none", () => {
  const tracker = new CodexLiveActivityTracker(clock().now);
  tracker.observe({ method: "thread/status/changed", threadId: T });
  tracker.observe({ method: "thread/tokenUsage/updated", threadId: T });
  assert.equal(tracker.snapshot(T), undefined);

  tracker.observe({
    method: "item/started",
    threadId: T,
    itemType: "toolCall",
  });
  assert.equal(
    tracker.snapshot(T)?.state,
    "tool",
    "a deploy mid-turn still gets a view",
  );
  tracker.observe({ method: "turn/completed", threadId: T });
  assert.equal(tracker.snapshot(T), undefined);

  tracker.observe({ method: "turn/started", threadId: T });
  tracker.clear(T);
  assert.equal(tracker.snapshot(T), undefined);
});

test("a new turn start discards counts a crashed turn left behind", () => {
  const tracker = new CodexLiveActivityTracker(clock().now);
  tracker.observe({ method: "turn/started", threadId: T });
  tracker.observe({
    method: "item/agentMessage/delta",
    threadId: T,
    deltaChars: 9,
  });
  tracker.observe({ method: "turn/started", threadId: T });
  assert.equal(tracker.snapshot(T)?.outputChars, 0);
});

test("views are per thread and the snapshot is a copy", () => {
  const tracker = new CodexLiveActivityTracker(clock().now);
  tracker.observe({ method: "turn/started", threadId: "a" });
  tracker.observe({ method: "turn/started", threadId: "b" });
  tracker.observe({
    method: "item/started",
    threadId: "b",
    itemType: "reasoning",
  });
  assert.equal(tracker.snapshot("a")?.state, "requesting");
  assert.equal(tracker.snapshot("b")?.state, "thinking");
  const copy = tracker.snapshot("a");
  if (copy) copy.outputChars = 99;
  assert.equal(tracker.snapshot("a")?.outputChars, 0);
});

test("observeMessage reads the app-server line the adapter parsed", () => {
  const tracker = new CodexLiveActivityTracker(clock().now);
  const line = (value: unknown) => readCodexMessage(value);
  tracker.observeMessage(
    line({
      method: "turn/started",
      params: { threadId: T, turn: { id: "t" } },
    }),
  );
  tracker.observeMessage(
    line({
      method: "item/started",
      params: { threadId: T, item: { type: "reasoning", id: "r" } },
    }),
  );
  assert.equal(tracker.snapshot(T)?.state, "thinking");
  tracker.observeMessage(
    line({
      method: "item/agentMessage/delta",
      params: { threadId: T, itemId: "m", delta: "hello" },
    }),
  );
  assert.equal(tracker.snapshot(T)?.outputChars, 5);
  tracker.observeMessage(
    line({
      method: "turn/completed",
      params: { threadId: T, turn: { id: "t" } },
    }),
  );
  assert.equal(tracker.snapshot(T), undefined);
});

// The adapter-level cases: a view that outlives its turn would keep answering "writing" forever.
async function writingThread(f: ReturnType<typeof fixture>) {
  const { threadId, turnId } = await f.adapter.start({
    cwd: f.draft,
    prompt: "Task",
  });
  f.notify("item/agentMessage/delta", { threadId, turnId, delta: "Draft" });
  assert.equal(f.adapter.liveActivity(threadId)?.state, "writing");
  return { threadId, turnId };
}

test("adapter: a completed turn clears the live view", async () => {
  const f = fixture();
  try {
    const { threadId, turnId } = await writingThread(f);
    f.notify("turn/completed", { threadId, turn: { id: turnId } });
    assert.equal(f.adapter.liveActivity(threadId), undefined);
  } finally {
    f.cleanup();
  }
});

test("adapter: a disconnect clears the live view", async () => {
  const f = fixture();
  try {
    const { threadId } = await writingThread(f);
    f.disconnect();
    assert.equal(f.adapter.liveActivity(threadId), undefined);
  } finally {
    f.cleanup();
  }
});

test("adapter: a resume that finds no active turn clears the live view", async () => {
  const f = fixture();
  try {
    const { threadId } = await writingThread(f);
    // The app-server says the turn ended while no notification reached us.
    for (const turn of f.threads[threadId].turns) turn.status = "completed";
    await f.adapter.resume(threadId);
    assert.equal(f.adapter.liveActivity(threadId), undefined);
  } finally {
    f.cleanup();
  }
});
