import type {
  LiveTurnActivity,
  LiveTurnState,
} from "../shared/task-activity.js";
import type { CodexMessage } from "./codex-protocol.js";
import { now } from "./storage.js";
import { TOOL_ITEM_TYPES } from "./task-activity.js";

/** The fields of an app-server notification the tracker reads; codex.ts projects them. */
export type CodexLiveNotification = {
  method: string;
  threadId?: string;
  /** `item.type` of an item/started or item/completed notification. */
  itemType?: string;
  /** Length of an `item/agentMessage/delta` text. */
  deltaChars?: number;
};

/** A running turn has no retrying or compacting signal here: app-server sends none we read. */
type CodexLiveState = Extract<
  LiveTurnState,
  "requesting" | "thinking" | "writing" | "tool"
>;

function stateOf(
  notification: CodexLiveNotification,
): CodexLiveState | undefined {
  const { method, itemType } = notification;
  if (method === "item/agentMessage/delta") return "writing";
  // Reasoning items are dropped from saved events (codex.ts), so only this view sees them.
  if (method.startsWith("item/reasoning/")) return "thinking";
  if (method === "item/started") {
    if (itemType === "reasoning") return "thinking";
    if (itemType === "agentMessage") return "writing";
    if (itemType && TOOL_ITEM_TYPES.has(itemType)) return "tool";
    return "requesting";
  }
  // Streaming output of a running tool: item/commandExecution/outputDelta and the like.
  const [root, kind] = method.split("/");
  if (root === "item" && kind && TOOL_ITEM_TYPES.has(kind)) return "tool";
  // The model goes back to the API after any item finishes.
  if (method === "item/completed") return "requesting";
  if (method === "turn/started") return "requesting";
  return undefined;
}

/**
 * In-memory view of what a Codex turn is doing, by thread. Not saved or published, for the
 * reasons given on LiveTurnActivity. Kept out of codex.ts, which only forwards notifications.
 */
export class CodexLiveActivityTracker {
  private readonly turns = new Map<string, LiveTurnActivity>();

  constructor(private readonly clock: () => string = now) {}

  /** Projects a parsed app-server message; the one call codex.ts makes for every line. */
  observeMessage(message: CodexMessage): void {
    const { params } = message;
    const itemType = params.item.type;
    const delta = params.raw.delta;
    this.observe({
      method: message.method ?? "",
      threadId: params.threadId || params.thread.id,
      itemType: typeof itemType === "string" ? itemType : undefined,
      deltaChars: typeof delta === "string" ? delta.length : undefined,
    });
  }

  observe(notification: CodexLiveNotification): void {
    const { method, threadId } = notification;
    if (!threadId) return;
    if (method === "turn/completed") {
      this.turns.delete(threadId);
      return;
    }
    // A turn that never completed (crash, reconnect) must not leak its counts into the next.
    if (method === "turn/started") this.turns.delete(threadId);
    const at = this.clock();
    let live = this.turns.get(threadId);
    // Only turn and item notifications start a view, so thread bookkeeping never fakes a turn.
    if (!live && !(method === "turn/started" || method.startsWith("item/")))
      return;
    live ??= {
      state: "requesting",
      since: at,
      lastSignalAt: at,
      outputChars: 0,
    };
    const state = stateOf(notification);
    if (state && state !== live.state) {
      live.state = state;
      live.since = at;
    }
    live.lastSignalAt = at;
    if (method === "item/agentMessage/delta")
      live.outputChars += notification.deltaChars ?? 0;
    this.turns.set(threadId, live);
  }

  clear(threadId: string): void {
    this.turns.delete(threadId);
  }

  clearAll(): void {
    this.turns.clear();
  }

  snapshot(threadId: string): LiveTurnActivity | undefined {
    const live = this.turns.get(threadId);
    return live ? { ...live } : undefined;
  }
}
