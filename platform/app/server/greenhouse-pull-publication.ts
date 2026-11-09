import type { Opening } from "../shared/types.js";
import type { GreenhousePosting } from "./greenhouse-source.js";
import {
  publishOpeningResearch,
  type OpeningMatch,
} from "./opening-workflow.js";
import type { PullRun, PullCandidate } from "./greenhouse-pull-records.js";
import {
  retainGreenhouseActivity,
  greenhouseOutcomeActivity,
  greenhouseStatusActivity,
} from "./greenhouse-pull-activity.js";
import { finishGreenhousePull } from "./greenhouse-pull-stop.js";
import { greenhouseReviewFinishing } from "./greenhouse-pull-records.js";
import { pullOpeningProvenance } from "./opening-pull/dates.js";
import type { CareersFetch } from "./careers/http.js";
import { enqueueFormChecks } from "./autofill/form-checks.js";
import { formCheckNewOpenings } from "./greenhouse-review-settings.js";
import { diagnosticLog } from "./diagnostic-log.js";
import { MissingRecordError, type Store } from "./storage.js";

function recordExistingOpening(
  store: Store,
  run: PullRun,
  candidate: PullCandidate,
  opening: Opening,
  matchedBy: OpeningMatch,
  clock: () => number,
) {
  // Research can resolve to a saved Opening after its missing details were merged.
  store.put("greenhouse_pull_candidate", candidate.id, {
    ...candidate,
    state: "existing",
    openingId: opening.id,
    reviewed: true,
    reason: `Matches an existing Fieldwork opening (${matchedBy === "jobId" ? "same requisition" : matchedBy === "url" ? "same posting URL" : "same company and title"}); missing details were merged into it.`,
  });
  store.put("greenhouse_pull_run", run.id, {
    ...retainGreenhouseActivity(
      store,
      greenhouseOutcomeActivity(run, candidate, "existing", "", clock()),
    ),
    currentId: undefined,
    error: undefined,
    phase: `Checked ${candidate.card.title}`,
    updatedAt: new Date(clock()).toISOString(),
  });
}

export function recordGreenhousePublishedOpening(
  store: Store,
  run: PullRun,
  candidate: PullCandidate,
  posting: GreenhousePosting,
  opening: Opening,
  matchedBy: OpeningMatch | undefined,
  candidates: () => PullCandidate[],
  clock: () => number,
) {
  if (matchedBy)
    return recordExistingOpening(
      store,
      run,
      candidate,
      opening,
      matchedBy,
      clock,
    );
  const raw = store.get("custom_opening", opening.id);
  if (!raw)
    throw new MissingRecordError(
      409,
      "custom_opening",
      opening.id,
      "Published Opening is missing",
    );
  store.put("custom_opening", opening.id, {
    ...raw,
    ...pullOpeningProvenance(run, candidate, posting),
  });
  store.put("greenhouse_pull_candidate", candidate.id, {
    ...candidate,
    state: "added",
    reason:
      "Source-backed remote software review saved as a new Fieldwork opening.",
    openingId: opening.id,
    reviewed: true,
  });
  const remaining = candidates();
  const reached =
    remaining.filter((row) => row.state === "added").length >= run.target;
  let next: PullRun = {
    ...greenhouseOutcomeActivity(run, candidate, "added", "", clock()),
    currentId: undefined,
    error: undefined,
    retryCandidateId: undefined,
    phase: `Added ${candidate.card.title}`,
    updatedAt: new Date(clock()).toISOString(),
  };
  if (greenhouseReviewFinishing(run) || reached)
    next = finishGreenhousePull(
      next,
      remaining,
      run.finishReason ?? (greenhouseReviewFinishing(run) ? "stop" : "target"),
    );
  store.put(
    "greenhouse_pull_run",
    run.id,
    retainGreenhouseActivity(
      store,
      greenhouseStatusActivity(run, next, clock()),
    ),
  );
}

export function publishGreenhouseReview(
  store: Store,
  run: PullRun,
  candidate: PullCandidate,
  posting: GreenhousePosting,
  taskId: string,
  candidates: () => PullCandidate[],
  clock: () => number,
  notify: () => void,
  formCheckRead?: CareersFetch,
) {
  let created = undefined as string | undefined;
  publishOpeningResearch(
    store,
    taskId,
    (opening: Opening, matchedBy?: OpeningMatch) => {
      if (!matchedBy) created = opening.id;
      recordGreenhousePublishedOpening(
        store,
        run,
        candidate,
        posting,
        opening,
        matchedBy,
        candidates,
        clock,
      );
    },
  );
  store.autoExport();
  notify();
  // After the commit and never into the pull: the check is a model-free extra.
  if (created && formCheckNewOpenings(store))
    try {
      enqueueFormChecks(store, [created], notify, formCheckRead);
    } catch (error) {
      diagnosticLog(
        "error",
        "form-checks",
        "Could not queue a form check for a new Opening",
        { openingId: created },
        error,
      );
    }
}
