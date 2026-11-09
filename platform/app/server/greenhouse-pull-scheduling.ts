import { isTaskBusy, isTaskWaiting, type TaskStatus } from "../shared/types.js";
import type { GreenhousePullSummary } from "../shared/greenhouse-pull.js";
import {
  greenhouseReviewFinishing,
  type PullRun,
  type PullCandidate,
} from "./greenhouse-pull-records.js";
import type { Store } from "./storage.js";
import {
  reviewCooldownActive,
  reviewStartBlocked,
} from "./greenhouse-review-cooldown.js";
import { pullProvider } from "./opening-pull/contract.js";
import {
  greenhouseSearchPending,
  rotatedGreenhouseCandidate,
} from "./greenhouse-query-plan.js";

import {
  greenhouseParallelReviews,
  greenhouseSearchLookahead,
} from "./greenhouse-review-settings.js";

export const greenhouseBacklogSize = (candidates: PullCandidate[]) =>
  candidates.filter((candidate) => candidate.state === "discovered").length;
export const failedGreenhouseReview = (status: TaskStatus | undefined) =>
  status !== undefined &&
  ["failed", "interrupted", "unavailable", "disconnected"].includes(status);

/** Reserve one possible addition per review, including staged and waiting tasks. */
export function chooseGreenhouseWork(
  store: Store,
  run: PullRun,
  candidates: PullCandidate[],
  at = Date.now(),
) {
  const parallelReviews = greenhouseParallelReviews(store);
  const reviews = candidates.filter((c) => c.state === "reviewing");
  const canStart = (candidate: PullCandidate) =>
    reviewWithinLimit(store, candidate, reviews, parallelReviews);
  const cooling = reviewCooldownActive(run, at);
  const retry = candidates.find(
    (candidate) =>
      candidate.id ===
        (run.retryCandidateId ?? run.reviewCooldown?.candidateId) &&
      !reviewStartBlocked(store, run, candidate, at) &&
      (candidate.state === "discovered" || candidate.state === "reviewing"),
  );
  if (
    retry &&
    canStart(retry) &&
    (retry.state === "discovered" || reviewCanAdvance(store, retry))
  )
    return { candidate: retry, canSearch: false };
  const ready = reviews.find(
    (c) =>
      canStart(c) &&
      !reviewStartBlocked(store, run, c, at) &&
      reviewCanAdvance(store, c),
  );
  if (ready) return { candidate: ready, canSearch: false };
  const finishing = greenhouseReviewFinishing(run);
  const remaining = finishing
    ? parallelReviews
    : run.target - candidates.filter((c) => c.state === "added").length;
  const candidate =
    !cooling && reviews.length < Math.min(parallelReviews, remaining)
      ? rotatedGreenhouseCandidate(
          run,
          candidates.filter(
            (c) =>
              c.state === "discovered" &&
              !reviews.some((review) => review.id === c.waitingFor),
          ),
        )
      : undefined;
  return {
    candidate,
    canSearch:
      !finishing &&
      !candidate &&
      // Refill only below the live discovered-candidate low-water mark.
      greenhouseBacklogSize(candidates) < greenhouseSearchLookahead(store) &&
      greenhouseSearchPending(run),
  };
}

function reviewWithinLimit(
  store: Store,
  candidate: PullCandidate,
  reviews: PullCandidate[],
  limit: number,
) {
  if (candidate.state === "discovered") return reviews.length < limit;
  const task = candidate.taskId
    ? store.get("task", candidate.taskId)
    : undefined;
  // Completed/failed turns still need settlement when a lowered limit is full.
  if (task?.threadId) return true;
  return (
    reviews.filter((review) => {
      const active = review.taskId
        ? store.get("task", review.taskId)
        : undefined;
      return active?.threadId && isTaskBusy(active.status);
    }).length < limit
  );
}

function reviewCanAdvance(store: Store, candidate: PullCandidate) {
  const task = candidate.taskId
    ? store.get("task", candidate.taskId)
    : undefined;
  return (
    !task ||
    !task.threadId ||
    (!isTaskBusy(task.status) && !isTaskWaiting(task.status))
  );
}

export function greenhouseReviews(store: Store, candidates: PullCandidate[]) {
  return candidates
    .filter((c) => c.state === "reviewing" && c.taskId)
    .map((c) => ({
      taskId: c.taskId!,
      title: `${c.card.company} · ${c.card.title}`,
      status: store.get("task", c.taskId!)?.status ?? "unavailable",
    })) satisfies NonNullable<GreenhousePullSummary["reviews"]>;
}

export function retryGreenhouseReviews(
  store: Store,
  candidates: PullCandidate[],
) {
  for (const candidate of candidates) {
    const task = candidate.taskId && store.get("task", candidate.taskId);
    if (
      candidate.state !== "reviewing" ||
      !task ||
      !failedGreenhouseReview(task.status)
    )
      continue;
    const saved = store.get("greenhouse_pull_candidate", candidate.id);
    if (!saved) continue;
    store.put("greenhouse_pull_candidate", candidate.id, {
      ...saved,
      state: "discovered",
      taskId: undefined,
      attempts: [...(candidate.attempts ?? []), task.id],
    });
  }
}

export function conflictingGreenhouseReview(
  store: Store,
  candidate: PullCandidate,
  candidates: PullCandidate[],
) {
  const posting = candidate.posting;
  if (!posting) return;
  return candidates.find((other) => {
    if (
      other.runId !== candidate.runId ||
      other.id === candidate.id ||
      other.state !== "reviewing" ||
      other.card.board !== candidate.card.board ||
      pullProvider(other.card) !== pullProvider(candidate.card)
    )
      return false;
    return (
      posting.aliases.includes(other.card.id) ||
      (posting.raw.internal_job_id != null &&
        String(posting.raw.internal_job_id) ===
          String(
            store.get("greenhouse_pull_candidate", other.id)?.posting?.raw
              .internal_job_id,
          ))
    );
  })?.id;
}
