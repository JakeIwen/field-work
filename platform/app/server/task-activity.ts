import type { TaskActivity } from "../shared/task-activity.js";
import type { TaskEvent } from "../shared/task-records.js";

/**
 * Item types that are a tool being used. Messages, reasoning and the user's prompt are not.
 * Shared with the live-turn tracker so the saved count and the live "tool" state agree.
 */
export const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "toolCall",
  "webSearch",
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "dynamicToolCall",
]);
/** Events that end the current turn, whether or not the provider announced it, with their label. */
const TURN_END_LABELS = new Map([
  ["turn/completed", "turn ended"],
  ["adapter/disconnected", "disconnected"],
  ["adapter/turnUncertain", "turn uncertain"],
  ["error", "error"],
]);
const READ_TOOL = "read_job_search_source";
const WRITE_TOOL = "write_application_source";

function basename(path: unknown): string | undefined {
  if (typeof path !== "string" || !path.trim()) return undefined;
  return path.trim().split(/[\\/]/).filter(Boolean).at(-1);
}

function field(params: TaskEvent["params"], key: string): unknown {
  return params?.[key];
}

/**
 * Both adapters emit `adapter/contextTool` after the matching `item/started`, so it labels the
 * last event but never counts a tool call (Claude: server/claude-code/agent.ts callTool; Codex:
 * server/codex.ts, item/tool/call). `params` carries `tool`, the source `path` and `success`.
 */
function contextToolLabel(params: TaskEvent["params"]): string {
  const tool = field(params, "tool");
  const name = typeof tool === "string" && tool ? tool : "tool";
  if (field(params, "success") === false) return `${name} failed`;
  const file = basename(field(params, "path"));
  if (name === READ_TOOL) return file ? `read ${file}` : "read source";
  if (name === WRITE_TOOL) return file ? `wrote ${file}` : "wrote source";
  return file ? `${name} ${file}` : name;
}

function toolItemLabel(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const tool = record.tool ?? record.type;
  return typeof tool === "string" ? tool : undefined;
}

function isToolItem(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const type = (item as Record<string, unknown>).type;
  return typeof type === "string" && TOOL_ITEM_TYPES.has(type);
}

/**
 * Folds one adapter event into the task's progress summary. Pure: the caller passes the time it
 * stamps on the task. Delta events only refresh `lastEventAt`; a tool or delta arriving with no
 * turn yet (a restart mid-turn) starts the count at turn 1 rather than leaving it at 0.
 */
export function reduceTaskActivity(
  previous: TaskActivity | undefined,
  event: TaskEvent,
  at: string,
): TaskActivity | undefined {
  const method = event.method;
  if (!method) return previous;
  const activity: TaskActivity = {
    ...(previous ?? { turn: 0, toolCalls: 0, lastEventAt: at }),
    lastEventAt: at,
  };
  if (method === "turn/started") {
    activity.turn += 1;
    activity.turnStartedAt = at;
    delete activity.turnCompletedAt;
    activity.toolCalls = 0;
    activity.lastEvent = "turn started";
  } else if (method === "error" && event.params?.willRetry === true) {
    // Codex retries after this notification, so the turn is still running.
    activity.lastEvent = "error, retrying";
  } else if (TURN_END_LABELS.has(method)) {
    activity.turnCompletedAt = at;
    activity.lastEvent = TURN_END_LABELS.get(method);
  } else if (method.startsWith("item/") || method === "adapter/contextTool") {
    // Output after a disconnect, an uncertain turn or a fatal error means the turn went on
    // (a resume); adapters send nothing for a turn after turn/completed.
    delete activity.turnCompletedAt;
    if (activity.turn === 0) {
      activity.turn = 1;
      activity.turnStartedAt = at;
    }
    const item = event.params?.item;
    if (method === "item/started" && isToolItem(item)) {
      activity.toolCalls += 1;
      const label = toolItemLabel(item);
      if (label) activity.lastEvent = label;
    } else if (method === "adapter/contextTool")
      activity.lastEvent = contextToolLabel(event.params);
  }
  return activity;
}
