import type { ModelSelection } from "../shared/model-selection.js";
import type { TaskMessage } from "../shared/task-records.js";
import { reduceTaskActivity } from "./task-activity.js";
import {
  messageSelection,
  recordedSelection,
  turnSelections,
  type SelectionEvent,
} from "../shared/model-selection.js";

/** Public task projection. Kept separate so protocol fixtures can verify reload/recovery behavior. */
export function hydrateTaskThread(
  task: any,
  thread: any,
  at: string,
  events: readonly SelectionEvent[] = [],
) {
  const turns = (thread?.turns || []).filter(Boolean);
  const active = turns.find((turn: any) => turn.status === "inProgress");
  const last = turns.at(-1);
  const status = active
    ? "running"
    : ["completed", "failed", "interrupted"].includes(last?.status)
      ? last.status
      : "idle";
  const selections = turnSelections(task, events);
  const messages = (task.messages || []).map((m: any) =>
    m.role === "assistant" ? { ...m, ...messageSelection(task, m, events) } : m,
  );
  for (const turn of turns)
    for (const item of turn.items || []) {
      if (
        item.type !== "agentMessage" ||
        !item.text ||
        messages.some((m: any) => m.itemId === item.id)
      )
        continue;
      messages.push({
        role: "assistant",
        text: item.text,
        itemId: item.id,
        turnId: turn.id,
        ...selections[turn.id],
        at: turn.completedAt
          ? new Date(turn.completedAt * 1000).toISOString()
          : at,
        recovered: true,
      });
    }
  return {
    ...task,
    threadId: thread?.id || task.threadId,
    thread: { thread },
    status,
    activeTurnId: active?.id || null,
    messages,
    turnSelections: selections,
    error:
      last?.status === "failed"
        ? last.error?.message || "Codex turn failed."
        : null,
    updatedAt: at,
  };
}

export function applyTaskEvent(
  task: any,
  event: any,
  at: string,
  events: readonly SelectionEvent[] = [],
) {
  let updated = {
    ...task,
    messages: (task.messages || []).map((m: any) =>
      m.role === "assistant"
        ? { ...m, ...messageSelection(task, m, events) }
        : m,
    ),
    turnSelections: turnSelections(task, events),
    pendingRequests: [...(task.pendingRequests || [])],
  };
  const method = event.method;
  const threadId =
    event.threadId || event.params?.threadId || event.params?.thread?.id;
  if (threadId) updated.threadId = threadId;
  const selection = recordedSelection(event.selection);
  const turnId = event.turnId ?? event.params?.turnId ?? event.params?.turn?.id;
  if (selection && turnId) updated.turnSelections[turnId] ??= selection;
  if (method === "adapter/threadCreated") {
    updated.status = "queued";
    updated.error = null;
  }
  if (method === "adapter/threadResumed") {
    updated = hydrateTaskThread(updated, event.params?.thread, at, events);
    updated.pendingRequests = [];
  }
  if (["adapter/threadCreated", "adapter/threadResumed"].includes(method)) {
    const confirmed = recordedSelection(event.params);
    if (confirmed) Object.assign(updated, confirmed, { modelConfirmed: true });
  }
  if (method === "turn/started") {
    if (selection) recordStartedSelection(updated, selection, turnId);
    updated.status = "running";
    updated.activeTurnId = event.params?.turn?.id;
    updated.error = null;
    updated.liveText = "";
  }
  if (method === "turn/completed") {
    const turn = event.params?.turn;
    updated = hydrateTaskThread(
      updated,
      { id: updated.threadId, turns: [turn] },
      at,
      events,
    );
    updated.status = ["completed", "failed", "interrupted"].includes(
      turn?.status,
    )
      ? turn.status
      : "disconnected";
    updated.activeTurnId = null;
    updated.pendingRequests = [];
    updated.liveText = "";
  }
  if (method === "adapter/request") {
    const request = event.request;
    if (request)
      updated.pendingRequests = [
        ...updated.pendingRequests.filter(
          (r: any) =>
            String(r.requestId ?? r.id) !==
            String(request.requestId ?? request.id),
        ),
        request,
      ];
    updated.status = /Approval/.test(request?.method || "")
      ? "waiting for approval"
      : "waiting for input";
  }
  if (
    method === "adapter/requestAnswered" ||
    method === "serverRequest/resolved"
  ) {
    const requestId = event.requestId ?? event.params?.requestId;
    updated.pendingRequests = updated.pendingRequests.filter(
      (r: any) => String(r.requestId ?? r.id) !== String(requestId),
    );
    const next = updated.pendingRequests[0];
    updated.status = next
      ? /Approval/.test(next.method)
        ? "waiting for approval"
        : "waiting for input"
      : updated.activeTurnId
        ? "running"
        : updated.status;
  }
  if (method === "adapter/disconnected" || method === "adapter/turnUncertain") {
    updated.status = "disconnected";
    updated.error =
      event.reason ||
      event.message ||
      event.params?.reason ||
      "Connection lost. Resume the saved thread before continuing.";
    updated.pendingRequests = [];
  }
  if (method === "error")
    updated.error =
      event.params?.error?.message ||
      event.params?.message ||
      "Codex reported an error.";
  if (method === "thread/tokenUsage/updated")
    updated.usage = event.params?.tokenUsage;
  if (method === "item/agentMessage/delta")
    updated.liveText = (
      (updated.liveText || "") + (event.params?.delta || "")
    ).slice(-200000);
  const item = event.params?.item;
  if (
    method === "item/completed" &&
    item?.type === "agentMessage" &&
    item.text &&
    !updated.messages.some((m: any) => m.itemId === item.id)
  )
    updated.messages.push({
      role: "assistant",
      text: item.text,
      itemId: item.id,
      turnId,
      ...(selection ?? updated.turnSelections[turnId]),
      at,
    });
  updated.activity = reduceTaskActivity(task.activity, event, at);
  return {
    ...updated,
    updatedAt: at,
    version: (task.version || 0) + 1,
  };
}

function recordStartedSelection(
  task: { messages: TaskMessage[] },
  selection: ModelSelection,
  turnId: string | undefined,
) {
  Object.assign(task, selection, { modelConfirmed: true });
  const queued = [...task.messages]
    .reverse()
    .find(
      (message) => message.role === "user" && message.delivery === "queued",
    );
  if (queued) Object.assign(queued, selection, { turnId });
}
