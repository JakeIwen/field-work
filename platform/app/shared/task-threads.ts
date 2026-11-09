import type { Task } from "./task-records.js";

/** All immutable thread identities belonging to one visible conversation. */
export function taskThreadIds(
  task: Pick<Task, "threadId" | "previousThreadIds">,
) {
  return [
    ...new Set([
      ...(task.previousThreadIds ?? []),
      ...(task.threadId ? [task.threadId] : []),
    ]),
  ];
}
