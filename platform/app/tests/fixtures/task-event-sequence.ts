import type { AgentEvent } from "../../server/task-kinds/task-completion.js";

const resumedThread = { id: "thread", turns: [] };

/** Exercise delta identity/caps, turn lifecycle, requests, usage and attribution changes. */
export const taskEventSequence = [
  {
    method: "adapter/threadCreated",
    params: { model: "old", effort: "high" },
  },
  { method: "turn/started", params: { turn: { id: "turn" } } },
  {
    method: "item/agentMessage/delta",
    turnId: "turn",
    params: { itemId: "answer", delta: "x".repeat(200050) },
  },
  {
    method: "item/agentMessage/delta",
    turnId: "turn",
    at: "ignored",
    params: { itemId: "answer", delta: "Résumé" },
  },
  {
    method: "item/agentMessage/delta",
    turnId: "other",
    params: { itemId: "answer", delta: "Different turn" },
  },
  {
    method: "item/agentMessage/delta",
    turnId: "other",
    params: { itemId: "other-answer", delta: "Different item" },
  },
  {
    method: "item/agentMessage/delta",
    params: { delta: "No identities" },
  },
  {
    method: "item/agentMessage/delta",
    params: { turnId: "nested-turn", delta: "Still coalesces" },
  },
  {
    method: "adapter/request",
    request: {
      requestId: "approval",
      method: "item/commandExecution/requestApproval",
    },
  },
  { method: "adapter/requestAnswered", requestId: "approval" },
  {
    method: "thread/tokenUsage/updated",
    params: { tokenUsage: { total: { totalTokens: 300 } } },
  },
  {
    method: "item/completed",
    turnId: "turn",
    params: {
      item: { id: "answer", type: "agentMessage", text: "Final answer" },
    },
  },
  {
    method: "turn/completed",
    params: {
      turn: {
        id: "turn",
        status: "completed",
        items: [{ id: "answer", type: "agentMessage", text: "Final answer" }],
      },
    },
  },
  {
    method: "adapter/threadResumed",
    params: { model: "new", effort: "xhigh", thread: resumedThread },
  },
  {
    method: "turn/started",
    selection: { model: "per-turn", effort: "high" },
    params: { turn: { id: "next" } },
  },
  {
    method: "item/completed",
    turnId: "next",
    params: {
      item: { id: "new-answer", type: "agentMessage", text: "New answer" },
    },
  },
  { method: "adapter/disconnected", reason: "Lost connection" },
] satisfies AgentEvent[];
