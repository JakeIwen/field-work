import type { Task } from "../shared/task-records.js";
import { sameHostedApplication } from "../shared/application-host.js";
import { HttpError, type Store } from "./storage.js";

/** Captured answers cannot recreate deleted work or cross a changed posting. */
export function assertApplicationAnswerPublication(
  store: Store,
  task: Task,
): void {
  const context = task.autofillContext;
  const openingId = task.context.openingId;
  const opening = openingId ? store.opening(openingId) : undefined;
  if (!context || !opening)
    throw new HttpError(
      409,
      "The Opening was removed. Application answers were not published.",
    );
  if (
    !sameHostedApplication(opening.url, context.url) ||
    (context.openingHash && context.openingHash !== opening.hash)
  )
    throw new HttpError(
      409,
      "The Opening changed during drafting. Generate current application answers.",
    );
  if (context.recordId) {
    const script = store.get("application_autofill", context.recordId);
    if (
      !script ||
      script.openingId !== opening.id ||
      (context.sourceHash && script.sourceHash !== context.sourceHash)
    )
      throw new HttpError(
        409,
        "The captured form script was removed or changed. Inspect the application again.",
      );
  }
}
