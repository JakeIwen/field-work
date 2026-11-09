import type { TaskSummary } from "../shared/task-records.js";

/** No client view reads these; they remain in task storage and the task endpoints. */
const storedOnlyFields = [
  "researchResult",
  "greenhouseDecision",
  "autofillDraft",
  "documentRuns",
] as const;

/** The global page snapshot is refetched after every pull event, so it carries only
 * what client views read. The full captured posting and pull review instructions stay
 * in task storage; review tasks keep their pull identity for list classification. */
export function clientTaskSummaries(tasks: TaskSummary[]): TaskSummary[] {
  return tasks.map((task) => {
    const page: Record<string, unknown> = { ...task };
    if (task.posting) page.posting = { ...task.posting, text: undefined };
    if (task.greenhousePull)
      page.greenhousePull = { ...task.greenhousePull, instructions: undefined };
    for (const field of storedOnlyFields) delete page[field];
    // Only optional fields were dropped or narrowed, so each page keeps its task variant.
    return page as TaskSummary;
  });
}
