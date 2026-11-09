import { diagnosticLog } from "./diagnostic-log.js";
import type { GreenhouseFinishReason } from "../shared/greenhouse-pull.js";
import {
  greenhouseActivityLane,
  greenhouseActivityLevel,
} from "../shared/greenhouse-pull.js";
import { recordGreenhouseParallelReviews } from "./greenhouse-review-settings.js";
import { chooseGreenhouseWork } from "./greenhouse-pull-scheduling.js";
import {
  legacyMultiProviderPull,
  type PullRun,
  type PullCandidate,
} from "./greenhouse-pull-records.js";
import type { Store } from "./storage.js";
import {
  retainGreenhouseActivity,
  appendGreenhouseActivity,
  greenhouseStatusActivity,
} from "./greenhouse-pull-activity.js";

export const greenhouseReviewsLeft = (candidates: PullCandidate[]) =>
  candidates.filter(
    (candidate) =>
      candidate.state === "discovered" || candidate.state === "reviewing",
  ).length;

/** Search completion does not discard the queue already discovered for this run. */
export function finishGreenhousePull(
  run: PullRun,
  candidates: PullCandidate[],
  reason: GreenhouseFinishReason,
): PullRun {
  const remaining = greenhouseReviewsLeft(candidates);
  return {
    ...run,
    finishReason: reason,
    finishReviews: remaining > 0,
    status: remaining
      ? "finishing"
      : reason === "target"
        ? "target_reached"
        : "stopped",
    searchInProgress: false,
    finalPacingRate: remaining ? undefined : run.pacingRate,
    retryAt: remaining ? run.retryAt : undefined,
    currentId: remaining ? run.currentId : undefined,
    error: remaining ? run.error : undefined,
    phase: remaining
      ? `${reason === "target" ? "Target reached" : "Stopped searching"}; finishing ${remaining} reviews`
      : reason === "target"
        ? "Target reached. All discovered candidates checked; remaining search results were not exhausted."
        : "Stopped searching. All discovered candidates checked.",
  };
}

export function stopGreenhousePull(
  run: PullRun,
  candidates: PullCandidate[],
  interruptReviews: boolean,
  at: number,
): PullRun {
  const reason = run.finishReason ?? "stop";
  if (!interruptReviews && !legacyMultiProviderPull(run))
    return finishGreenhousePull(run, candidates, reason);
  const remaining = greenhouseReviewsLeft(candidates);
  const stopped: PullRun = {
    ...run,
    status: reason === "target" ? "target_reached" : "stopped",
    finishReason: reason,
    finishReviews: false,
    searchInProgress: false,
    retryAt: undefined,
    phase: `Stopped ${remaining} reviews. Queued candidates and saved evidence are retained.`,
  };
  return interruptReviews
    ? appendGreenhouseActivity(
        stopped,
        {
          lane: greenhouseActivityLane.review,
          level: greenhouseActivityLevel.info,
          text: `Stopped ${remaining} reviews`,
        },
        at,
      )
    : stopped;
}

export function greenhousePullHasWork(store: Store) {
  return Boolean(
    store.db
      .prepare(
        `SELECT 1 FROM records WHERE kind='greenhouse_pull_run'
    AND (json_extract(json, '$.status') IN ('running','cooldown','finishing')
      OR (json_extract(json, '$.status')='stopped' AND json_extract(json, '$.finishReviews')=1))
    AND NOT EXISTS (SELECT 1 FROM json_each(records.json, '$.providers') WHERE value <> 'greenhouse') LIMIT 1`,
      )
      .get(),
  );
}

/** Older finishing runs progress independently of the currently searching run. */
export function finishingGreenhouseWork(
  store: Store,
  at: number,
  notify: () => void,
) {
  const rows = store.db
    .prepare(
      `
    SELECT json FROM records WHERE kind='greenhouse_pull_run'
      AND (json_extract(json, '$.status')='finishing'
        OR (json_extract(json, '$.status')='stopped' AND json_extract(json, '$.finishReviews')=1))
    ORDER BY rowid
  `,
    )
    .all() as { json: string }[];
  for (const row of rows) {
    let run = JSON.parse(row.json) as PullRun;
    if (legacyMultiProviderPull(run)) continue;
    const candidates = (
      store.db
        .prepare(
          "SELECT json_remove(json, '$.posting') AS json FROM records WHERE kind='greenhouse_pull_candidate' AND id GLOB ? ORDER BY rowid",
        )
        .all(`${run.id}:*`) as { json: string }[]
    ).map((saved) => JSON.parse(saved.json) as PullCandidate);
    const next = finishGreenhousePull(
      run,
      candidates,
      run.finishReason ?? "stop",
    );
    const expired = run.retryAt && Date.parse(run.retryAt) <= at;
    if (expired) {
      next.retryAt = undefined;
      next.error = undefined;
    }
    if (next.status !== run.status || next.phase !== run.phase || expired) {
      run = {
        ...greenhouseStatusActivity(run, next, at),
        updatedAt: new Date(at).toISOString(),
      };
      store.put(
        "greenhouse_pull_run",
        run.id,
        retainGreenhouseActivity(store, run),
      );
      store.autoExport();
      notify();
    }
    if (
      run.status !== "finishing" ||
      (run.retryAt && Date.parse(run.retryAt) > at)
    )
      continue;
    run = recordGreenhouseParallelReviews(store, run, at, notify);
    const work = chooseGreenhouseWork(store, run, candidates, at);
    if (!work.candidate) continue;
    const candidate = store.get("greenhouse_pull_candidate", work.candidate.id);
    if (candidate) return { run, candidate };
    diagnosticLog(
      "warn",
      "greenhouse-pull",
      `Skipping missing finishing Greenhouse candidate ${work.candidate.id}`,
    );
  }
}
