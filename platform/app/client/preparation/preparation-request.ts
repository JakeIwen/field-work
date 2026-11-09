import { answersOnlyPreparationReady, type ApplicationPreparation, type PreparationScope } from "../../shared/application-preparation";

export const answersOnlyGestureTitle = "Shift-click to prepare answers only, without generating documents.";

// Shift activates answers-only; it must not also extend a text selection across rows.
export function preventShiftTextSelection(event: Pick<MouseEvent, "shiftKey" | "preventDefault">) {
  if (event.shiftKey) event.preventDefault();
}

export function preparationRequestNotice(run: ApplicationPreparation | undefined, scope: PreparationScope) {
  if (scope !== "answers" || run?.status !== "ready" || run.stale) return undefined;
  return answersOnlyPreparationReady(run)
    ? "Answers are already drafted. Click Generate Docs without Shift to finish the documents."
    : "Documents and autofill are already ready.";
}

export function answersOnlyStatus(count: number) {
  return `Answers drafted · documents not generated · ${count} ${count === 1 ? "item" : "items"} to answer yourself`;
}
