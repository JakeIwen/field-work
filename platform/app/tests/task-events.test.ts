import test from "node:test";
import {
  messageSelection,
  modelLabel,
  taskSelection,
} from "../shared/model-selection.js";
import assert from "node:assert/strict";
import { applyTaskEvent, hydrateTaskThread } from "../server/task-events.js";
const at = "2026-09-06T17:00:00.000Z";
const initial = () => ({
  id: "task-one",
  threadId: "thread-one",
  messages: [],
  status: "queued",
  version: 1,
});

test("actual adapter approval shape waits, persists requests, and returns to running only after all answers", () => {
  let task: any = applyTaskEvent(
    initial(),
    {
      method: "turn/started",
      threadId: "thread-one",
      params: { turn: { id: "turn-one" } },
    },
    at,
  );
  const request = {
    method: "item/commandExecution/requestApproval",
    requestId: "r1",
    threadId: "thread-one",
    params: { command: "example" },
  };
  task = applyTaskEvent(
    task,
    {
      method: "adapter/request",
      threadId: "thread-one",
      request,
      status: "waiting_approval",
    },
    at,
  );
  assert.equal(task.status, "waiting for approval");
  assert.equal(task.pendingRequests[0].requestId, "r1");
  task = applyTaskEvent(
    task,
    {
      method: "adapter/request",
      threadId: "thread-one",
      request: {
        ...request,
        requestId: "r2",
        method: "item/tool/requestUserInput",
      },
    },
    at,
  );
  assert.equal(task.status, "waiting for input");
  task = applyTaskEvent(
    task,
    { method: "adapter/requestAnswered", requestId: "r2" },
    at,
  );
  assert.equal(task.status, "waiting for approval");
  task = applyTaskEvent(
    task,
    { method: "serverRequest/resolved", params: { requestId: "r1" } },
    at,
  );
  assert.equal(task.status, "running");
  assert.equal(task.pendingRequests.length, 0);
});

test("recovery hydrates missing public messages without duplicating saved replies or hiding active turns", () => {
  const thread = {
    id: "thread-one",
    turns: [
      {
        id: "old",
        status: "completed",
        completedAt: 1788700000,
        items: [
          {
            id: "answer-1",
            type: "agentMessage",
            text: "A real earlier reply.",
          },
        ],
      },
      { id: "active", status: "inProgress", items: [] },
    ],
  };
  const once = hydrateTaskThread(initial(), thread, at);
  assert.equal(once.status, "running");
  assert.equal(once.activeTurnId, "active");
  assert.equal(once.messages.length, 1);
  const twice = hydrateTaskThread(once, thread, at);
  assert.equal(twice.messages.length, 1);
  const failed = hydrateTaskThread(
    twice,
    {
      id: "thread-one",
      turns: [
        {
          id: "failed",
          status: "failed",
          items: [],
          error: { message: "Quota unavailable" },
        },
      ],
    },
    at,
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "Quota unavailable");
});

test("disconnect uses actual top-level reason and completion does not report a failed turn as completed", () => {
  let task: any = applyTaskEvent(
    initial(),
    {
      method: "adapter/disconnected",
      threadId: "thread-one",
      reason: "The child exited.",
    },
    at,
  );
  assert.equal(task.status, "disconnected");
  assert.equal(task.error, "The child exited.");
  task = applyTaskEvent(
    task,
    {
      method: "turn/completed",
      threadId: "thread-one",
      params: {
        turn: {
          id: "turn-one",
          status: "failed",
          error: { message: "Model unavailable" },
          items: [],
        },
      },
    },
    at,
  );
  assert.equal(task.status, "failed");
  assert.equal(task.error, "Model unavailable");
  assert.equal(task.activeTurnId, null);
});

test("stream chunks update live text and final messages survive conversation reloads", () => {
  let task: any = initial();
  for (const delta of ["A ", "complete ", "reply."])
    task = applyTaskEvent(
      task,
      {
        method: "item/agentMessage/delta",
        threadId: "thread-one",
        turnId: "turn-one",
        params: { itemId: "answer", delta },
      },
      at,
    );
  assert.equal(task.liveText, "A complete reply.");
  task = applyTaskEvent(
    task,
    {
      method: "item/completed",
      threadId: "thread-one",
      turnId: "turn-one",
      params: {
        item: { id: "answer", type: "agentMessage", text: "A complete reply." },
      },
    },
    at,
  );
  task = applyTaskEvent(
    task,
    {
      method: "turn/completed",
      threadId: "thread-one",
      params: {
        turn: {
          id: "turn-one",
          status: "completed",
          items: [
            { id: "answer", type: "agentMessage", text: "A complete reply." },
          ],
        },
      },
    },
    at,
  );
  assert.equal(task.status, "completed");
  assert.equal(task.messages.length, 1);
  assert.equal(task.messages[0].text, "A complete reply.");
  assert.equal(task.liveText, "");
});

test("usage totals are replaced, not summed, and survive completion, revision and resume", () => {
  let task: any = {
    id: "usage-task",
    threadId: "thread-one",
    status: "running",
  };
  const usage = (totalTokens: number) => ({
    total: {
      totalTokens,
      inputTokens: totalTokens - 10,
      outputTokens: 10,
      cachedInputTokens: 50,
      reasoningOutputTokens: 2,
    },
    last: { totalTokens: 5 },
    modelContextWindow: 828400,
  });
  const event = (value: any) => ({
    method: "thread/tokenUsage/updated",
    params: { threadId: "thread-one", tokenUsage: value },
  });
  task = applyTaskEvent(task, event(usage(100)), at);
  task = applyTaskEvent(task, event(usage(100)), at);
  assert.equal(task.usage.total.totalTokens, 100);
  task = applyTaskEvent(
    task,
    {
      method: "turn/completed",
      params: { turn: { id: "one", status: "completed", items: [] } },
    },
    at,
  );
  task = applyTaskEvent(
    task,
    { method: "turn/started", params: { turn: { id: "two" } } },
    at,
  );
  assert.equal(task.usage.total.totalTokens, 100);
  task = applyTaskEvent(task, event(usage(150)), at);
  task = hydrateTaskThread(
    task,
    {
      id: "thread-one",
      turns: [{ id: "two", status: "completed", items: [] }],
    },
    at,
  );
  assert.equal(task.usage.total.totalTokens, 150);
  assert.equal(task.usage.total.cachedInputTokens, 50);
  assert.equal(task.usage.last.totalTokens, 5);
  assert.equal(task.status, "completed");
});

test("confirmed model labels persist per reply when the recommended model changes", () => {
  const old = { model: "gpt-6-astra", effort: "ultra" };
  const next = { model: "future-codex-default", effort: "high" };
  let task: any = initial();
  task = applyTaskEvent(
    task,
    {
      method: "adapter/threadCreated",
      params: { thread: { id: "one" }, ...old },
    },
    at,
  );
  task = applyTaskEvent(
    task,
    {
      method: "turn/started",
      selection: old,
      params: { turn: { id: "old-turn" } },
    },
    at,
  );
  task = applyTaskEvent(
    task,
    {
      method: "item/completed",
      turnId: "old-turn",
      selection: old,
      params: {
        item: {
          id: "old-answer",
          type: "agentMessage",
          text: "Earlier answer",
        },
      },
    },
    at,
  );
  task = applyTaskEvent(
    task,
    {
      method: "adapter/threadResumed",
      params: { ...next, thread: { id: "one", turns: [] } },
    },
    at,
  );
  assert.deepEqual(taskSelection(task), next);
  assert.deepEqual(messageSelection(task, task.messages[0]), old);
  task = applyTaskEvent(
    task,
    {
      method: "turn/started",
      selection: next,
      params: { turn: { id: "next-turn" } },
    },
    at,
  );
  task = applyTaskEvent(
    task,
    {
      method: "item/completed",
      turnId: "next-turn",
      selection: next,
      params: {
        item: { id: "next-answer", type: "agentMessage", text: "New answer" },
      },
    },
    at,
  );
  const restored = JSON.parse(JSON.stringify(task));
  assert.equal(
    modelLabel(messageSelection(restored, restored.messages[0])),
    "gpt-6-astra · ultra",
  );
  assert.equal(
    modelLabel(messageSelection(restored, restored.messages[1])),
    "future-codex-default · high",
  );
});

test("recovered replies use their turn selection and leave unknown history unlabeled", () => {
  const task = {
    ...initial(),
    model: "new-model",
    effort: "high",
    turnSelections: { old: { model: "old-model", effort: "ultra" } },
  };
  const restored = hydrateTaskThread(
    task,
    {
      id: "one",
      turns: [
        {
          id: "old",
          status: "completed",
          items: [{ id: "known", type: "agentMessage", text: "Known" }],
        },
        {
          id: "unknown",
          status: "completed",
          items: [{ id: "unknown", type: "agentMessage", text: "Unknown" }],
        },
      ],
    },
    at,
  );
  assert.equal(
    modelLabel(messageSelection(restored, restored.messages[0])),
    "old-model · ultra",
  );
  assert.equal(
    modelLabel(messageSelection(restored, restored.messages[1])),
    "Model not recorded",
  );
});

test("legacy reply labels can be recovered from recorded thread and item events", () => {
  const task = {
    ...initial(),
    model: "new-model",
    effort: "high",
    events: [
      {
        method: "adapter/threadCreated",
        params: { model: "recorded-model", effort: "ultra" },
      },
      {
        method: "item/completed",
        turnId: "old",
        params: { item: { id: "answer" } },
      },
    ],
  };
  assert.deepEqual(messageSelection(task, { itemId: "answer" }, task.events), {
    model: "recorded-model",
    effort: "ultra",
  });
  assert.equal(
    messageSelection(task, { itemId: "not-recorded" }, task.events),
    null,
  );
});
