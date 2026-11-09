import { isTaskBusy } from "./types.js";
import type { TaskStatus } from "./types.js";
import {
  preparationDocumentsSaved,
  type ApplicationDocumentKind,
} from "./application-preparation.js";

type DocumentTask = {
  status: string;
  context?: { openingId?: string };
  preset: string;
  autofillContext?: object;
  documentResult?: { status: string };
  autofillResult?: { status: string };
};
type PreparationRun = {
  id: string;
  openingId: string;
  status: string;
  phase?: string;
  documentIds?: string[];
  documentKinds?: ApplicationDocumentKind[];
};

export function openingGenerationCounts(
  runs: PreparationRun[],
): Record<string, number> {
  const completed = new Map<string, Set<string>>();
  for (const run of runs) {
    // Advancing past documents means every expected PDF passed validation. A later
    // answer/form/packaging failure must not hide that successful generation.
    const documentsReady =
      ["answers", "packaging", "ready"].includes(run.phase ?? "") &&
      preparationDocumentsSaved({
        documentIds: run.documentIds ?? [],
        documentKinds: run.documentKinds,
      });
    if (run.status !== "ready" && !documentsReady) continue;
    if (!completed.has(run.openingId)) completed.set(run.openingId, new Set());
    completed.get(run.openingId)!.add(run.id);
  }
  return Object.fromEntries(
    [...completed].map(([id, runs]) => [id, runs.size]),
  );
}

export function openingDocumentTaskBusy(
  openingId: string,
  tasks: DocumentTask[],
): boolean {
  return tasks.some(
    (t) =>
      t.context?.openingId === openingId &&
      ([
        "posting-application",
        "posting-resume",
        "posting-cover-letter",
      ].includes(t.preset) ||
        t.autofillContext) &&
      (isTaskBusy(t.status as TaskStatus) ||
        t.documentResult?.status === "rendering" ||
        t.autofillResult?.status === "saving"),
  );
}
