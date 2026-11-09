import { hostedApplication } from "../../shared/application-host";
import { answersOnlyPreparationReady, preparationBusy, type PreparationScope } from "../../shared/application-preparation";
import { openingDocumentTaskBusy } from "../../shared/opening-documents";
import type { AppState } from "../../shared/types";

export function selectedPreparationTargets(state: AppState, selection: Set<string>, scope: PreparationScope) {
  const skipped = { busy: 0, fullReady: 0, answersReady: 0, unsupported: 0 };
  const runs = new Map(state.preparations?.map(run => [run.openingId, run]));
  const targets = state.openings.filter(opening => {
    if (!selection.has(opening.id)) return false;
    const run = runs.get(opening.id);
    if (preparationBusy(run) || openingDocumentTaskBusy(opening.id, state.tasks)) skipped.busy++;
    else if (run?.status === "ready" && !run.stale && run.scope !== "answers") skipped.fullReady++;
    else if (scope === "answers" && answersOnlyPreparationReady(run)) skipped.answersReady++;
    else if (scope === "answers" && hostedApplication(opening.url)?.provider !== "greenhouse") skipped.unsupported++;
    else return true;
    return false;
  });
  return { targets, skipped };
}

export function preparationSkipSummary(skipped: ReturnType<typeof selectedPreparationTargets>["skipped"]) {
  return [
    skipped.busy ? `${skipped.busy} in progress` : "",
    skipped.fullReady ? `${skipped.fullReady} already ready` : "",
    skipped.answersReady ? `${skipped.answersReady} answers already drafted` : "",
    skipped.unsupported ? `${skipped.unsupported} not autofill-eligible` : "",
  ].filter(Boolean);
}
