import type {
  ApplicationPreparation,
  PreparationActivityResponse,
} from "../shared/application-preparation.js";
import type {
  LiveTurnActivity,
  PreparationTaskActivity,
  PreparationTaskRole,
} from "../shared/task-activity.js";
import { isTaskTurnActive } from "../shared/types.js";
import type { Task } from "../shared/task-records.js";

export type PreparationActivityDeps = {
  latestRecord(openingId: string): ApplicationPreparation | undefined;
  getTask(id: string): Task | undefined;
  /** The adapter's in-memory view of a running turn; absent for threads it no longer tracks. */
  liveActivity(threadId: string): LiveTurnActivity | undefined;
};

/**
 * Reads only the run's two tasks and the adapter's in-memory turn state, so the client can poll
 * it every few seconds without `latest()`'s document checks or an `/api/state` rebuild.
 */
export function preparationActivity(
  deps: PreparationActivityDeps,
  openingId: string,
): PreparationActivityResponse {
  const run = deps.latestRecord(openingId);
  if (!run) return { run: null, tasks: [] };
  const roles: [PreparationTaskRole, string | undefined][] = [
    ["documents", run.documentTaskId],
    ["answers", run.answerTaskId],
  ];
  const tasks: PreparationTaskActivity[] = [];
  for (const [role, id] of roles) {
    const task = id ? deps.getTask(id) : undefined;
    if (!task) continue; // A deleted task simply has no activity to show.
    tasks.push({
      id: task.id,
      role,
      status: task.status,
      ...(task.model ? { model: task.model } : {}),
      ...(task.effort ? { effort: task.effort } : {}),
      live:
        isTaskTurnActive(task.status) && task.threadId
          ? (deps.liveActivity(task.threadId) ?? null)
          : null,
    });
  }
  return {
    run: {
      id: run.id,
      phase: run.phase,
      status: run.status,
      updatedAt: run.updatedAt,
    },
    tasks,
  };
}
