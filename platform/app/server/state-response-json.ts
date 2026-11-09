import type { AppState } from "../shared/types.js";
import type { TaskSummary } from "../shared/task-records.js";
import { clientTaskSummaries } from "./client-task-summary.js";
import { isCachedStateValue } from "./storage-state-cache.js";

const recordJson = new WeakMap<object, string>();
const taskJson = new WeakMap<TaskSummary, string>();
const taskListJson = new WeakMap<TaskSummary[], string>();

function recordFragment(value: unknown): string | undefined {
  if (!isCachedStateValue(value)) return JSON.stringify(value);
  let json = recordJson.get(value);
  if (json === undefined) {
    json = JSON.stringify(value);
    recordJson.set(value, json);
  }
  return json;
}

function clientTasksFragment(tasks: TaskSummary[]): string {
  // Noncached snapshots (including tests and other callers) remain ordinary JSON.
  if (!isCachedStateValue(tasks))
    return JSON.stringify(clientTaskSummaries(tasks));
  let json = taskListJson.get(tasks);
  if (json !== undefined) return json;
  const parts = tasks.map((task) => {
    let part = taskJson.get(task);
    if (part === undefined) {
      part = JSON.stringify(clientTaskSummaries([task])[0]);
      taskJson.set(task, part);
    }
    return part;
  });
  json = `[${parts.join(",")}]`;
  taskListJson.set(tasks, json);
  return json;
}

/** Object spread preserves the positions of overridden snapshot keys, including
 * historical meta fields. Enumerating that object also preserves integer-key
 * ordering and JSON's omission of undefined properties. Only immutable Store
 * values reuse fragments; runtime, file and clock projections serialize anew. */
export function stateResponseJson(
  snapshot: AppState,
  live: Record<string, unknown>,
) {
  const state = { ...snapshot, ...live };
  const parts: string[] = [];
  for (const [key, value] of Object.entries(state)) {
    const json =
      key === "tasks" && value === snapshot.tasks
        ? clientTasksFragment(snapshot.tasks)
        : recordFragment(value);
    if (json !== undefined) parts.push(`${JSON.stringify(key)}:${json}`);
  }
  return `{${parts.join(",")}}`;
}
