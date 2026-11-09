import test from "node:test";
import assert from "node:assert/strict";
import { reduceTaskActivity } from "../server/task-activity.js";
import { applyTaskEvent } from "../server/task-events.js";
import { clientTaskSummaries } from "../server/client-task-summary.js";
import type { TaskActivity } from "../shared/task-activity.js";
import type { TaskEvent } from "../shared/task-records.js";

const at = (n: number) => `2026-11-06T10:00:${String(n).padStart(2, "0")}.000Z`;

function replay(events: TaskEvent[]): TaskActivity | undefined {
  let activity: TaskActivity | undefined;
  events.forEach((event, index) => {
    activity = reduceTaskActivity(activity, event, at(index));
  });
  return activity;
}

const turnStarted: TaskEvent = {
  method: "turn/started",
  params: { turn: { id: "t1", status: "inProgress" } },
};
const turnCompleted: TaskEvent = {
  method: "turn/completed",
  params: { turn: { id: "t1", status: "completed" } },
};
const toolStarted = (type: string, tool?: string): TaskEvent => ({
  method: "item/started",
  params: { item: { type, id: `i-${type}`, ...(tool ? { tool } : {}) } },
});
const contextTool = (
  tool: string,
  path: string | undefined,
  success = true,
): TaskEvent => ({
  method: "adapter/contextTool",
  params: { tool, path, success },
});

test("a Claude-shaped turn counts tool items once and labels context tools", () => {
  const activity = replay([
    turnStarted,
    toolStarted("toolCall", "mcp__fieldwork__read_job_search_source"),
    contextTool(
      "read_job_search_source",
      "/work/drafts/task-1/github_evidence_dossier.md",
    ),
    toolStarted("toolCall", "mcp__fieldwork__write_application_source"),
    contextTool("write_application_source", "resume_draft.md"),
    toolStarted("webSearch"),
  ]);
  assert.equal(activity?.turn, 1);
  assert.equal(activity?.toolCalls, 3, "adapter/contextTool is never counted");
  assert.equal(activity?.turnStartedAt, at(0));
  assert.equal(activity?.lastEventAt, at(5));
  assert.equal(activity?.lastEvent, "webSearch");
});

test("contextTool labels name the file, the write, and failures", () => {
  const label = (event: TaskEvent) =>
    reduceTaskActivity(undefined, event, at(0))?.lastEvent;
  assert.equal(
    label(contextTool("read_job_search_source", "a/b/dossier.md")),
    "read dossier.md",
  );
  assert.equal(
    label(contextTool("write_application_source", "resume.md")),
    "wrote resume.md",
  );
  assert.equal(
    label(contextTool("write_application_source", "resume.md", false)),
    "write_application_source failed",
  );
  assert.equal(
    label(contextTool("read_job_search_source", undefined)),
    "read source",
  );
});

test("a Codex-shaped turn ignores messages, reasoning and user items", () => {
  const activity = replay([
    turnStarted,
    toolStarted("userMessage"),
    toolStarted("reasoning"),
    toolStarted("agentMessage"),
    toolStarted("commandExecution"),
    toolStarted("fileChange"),
    { method: "item/agentMessage/delta", params: { delta: "hi" } },
    { method: "item/completed", params: { item: { type: "agentMessage" } } },
  ]);
  assert.equal(activity?.toolCalls, 2);
  assert.equal(activity?.lastEvent, "fileChange");
});

test("the turn count starts at 1 when a tool arrives with no turn yet", () => {
  const midTurn = replay([toolStarted("toolCall", "x")]);
  assert.equal(midTurn?.turn, 1);
  assert.equal(midTurn?.toolCalls, 1);
  assert.equal(midTurn?.turnStartedAt, at(0));
  const afterRestart = replay([toolStarted("toolCall", "x"), turnStarted]);
  assert.equal(afterRestart?.turn, 2);
  assert.equal(afterRestart?.toolCalls, 0);
});

test("thread bookkeeping events do not invent a turn", () => {
  const activity = replay([{ method: "adapter/threadCreated" }]);
  assert.equal(activity?.turn, 0);
  assert.equal(activity?.turnStartedAt, undefined);
});

test("completion and a new start set and clear turnCompletedAt", () => {
  const done = replay([
    turnStarted,
    toolStarted("toolCall", "x"),
    turnCompleted,
  ]);
  assert.equal(done?.turnCompletedAt, at(2));
  assert.equal(done?.toolCalls, 1, "the finished turn keeps its count");
  const second = reduceTaskActivity(done, turnStarted, at(3));
  assert.equal(second?.turn, 2);
  assert.equal(second?.turnCompletedAt, undefined);
  assert.equal(second?.toolCalls, 0);
  assert.equal(second?.turnStartedAt, at(3));
});

test("disconnects, uncertain turns and errors end the turn", () => {
  for (const method of [
    "adapter/disconnected",
    "adapter/turnUncertain",
    "error",
  ]) {
    const activity = replay([turnStarted, { method }]);
    assert.equal(activity?.turnCompletedAt, at(1), method);
  }
});

test("an event without a method leaves the summary alone", () => {
  const before = replay([turnStarted]);
  assert.equal(reduceTaskActivity(before, { method: "" }, at(9)), before);
});

test("applyTaskEvent stores the summary and the client snapshot keeps it", () => {
  const task = { id: "t", status: "queued", version: 0, messages: [] };
  const started = applyTaskEvent(task, turnStarted, at(0));
  const worked = applyTaskEvent(started, toolStarted("toolCall", "x"), at(1));
  assert.equal(worked.activity.toolCalls, 1);
  assert.equal(worked.activity.turn, 1);
  const [summary] = clientTaskSummaries([worked]);
  assert.deepEqual(summary.activity, worked.activity);
});

test("a retriable error is not the end of the turn, and output after a stop reopens it", () => {
  const retried = replay([
    turnStarted,
    { method: "error", params: { willRetry: true } },
    toolStarted("toolCall", "x"),
  ]);
  assert.equal(retried?.turnCompletedAt, undefined);

  const completed = replay([
    turnStarted,
    { method: "error", params: { willRetry: true } },
    toolStarted("toolCall", "x"),
    turnCompleted,
  ]);
  assert.equal(completed?.turnCompletedAt, at(3));

  const fatal = replay([
    turnStarted,
    { method: "error", params: { willRetry: false } },
  ]);
  assert.equal(fatal?.turnCompletedAt, at(1));

  // A resumed turn keeps producing output after the disconnect that "ended" it.
  const resumed = reduceTaskActivity(
    replay([turnStarted, { method: "adapter/disconnected" }]),
    toolStarted("toolCall", "y"),
    at(5),
  );
  assert.equal(resumed?.turnCompletedAt, undefined);
});
