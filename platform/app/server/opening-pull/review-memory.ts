import { tunable } from "../tunables.js";
import { FIELDWORK_TIMEZONE } from "../../shared/timezone.js";
import type { Task } from "../../shared/task-records.js";
import { HttpError, sha256, type Store } from "../storage.js";
import {
  legacyMultiProviderPull,
  type PullCandidate,
  type PullRun,
} from "../greenhouse-pull-records.js";
import { greenhouseGuidanceInstructions } from "./guidance.js";
import {
  greenhouseReviewInputs,
  recoverReviewInputs,
  reviewFingerprint,
  reviewPostingHash,
} from "./review-inputs.js";

import { defaultGreenhousePullPolicy } from "../../shared/greenhouse-policy.js";
import { runGreenhousePolicy } from "./policy.js";

export const deferredReviewMemoryMs =
  defaultGreenhousePullPolicy.deferralReuseHours * 60 * 60 * 1000;
export const reviewMemoryKind = "greenhouse_review_memory";
export type GreenhouseReviewMemory = {
  id: string;
  board: string;
  aliases: string[];
  internalJobId?: string;
  outcome: "excluded" | "deferred";
  decidedAt: string;
  runId: string;
  candidateId: string;
  taskId: string;
  reason: string;
  fingerprint: string;
  postingContentHash: string;
};
export const reviewMemoryId = (candidate: PullCandidate) =>
  `${candidate.card.board}:${candidate.card.id}`;

function sameRequisition(
  memory: GreenhouseReviewMemory,
  candidate: PullCandidate,
) {
  return (
    memory.board === candidate.card.board &&
    (memory.aliases.includes(candidate.card.id) ||
      candidate.posting?.aliases.some((id) => memory.aliases.includes(id)) ||
      (memory.internalJobId !== undefined &&
        candidate.posting?.raw.internal_job_id != null &&
        memory.internalJobId === String(candidate.posting.raw.internal_job_id)))
  );
}

export function rememberedReview(
  store: Store,
  run: PullRun,
  candidate: PullCandidate,
  at: number,
) {
  const policy = runGreenhousePolicy(run, store.settings());
  if (
    legacyMultiProviderPull(run) ||
    candidate.forceReview ||
    !policy.reuseReviews
  )
    return undefined;
  const inputs = greenhouseReviewInputs(store, run, candidate);
  if (!inputs) return undefined;
  const fingerprint = reviewFingerprint(inputs);
  return store
    .list(reviewMemoryKind)
    .filter(
      (memory) =>
        (memory.id === reviewMemoryId(candidate) ||
          sameRequisition(memory, candidate)) &&
        memory.postingContentHash === inputs.postingContent &&
        memory.fingerprint === fingerprint &&
        Number.isFinite(Date.parse(memory.decidedAt)) &&
        (memory.outcome !== "deferred" ||
          at - Date.parse(memory.decidedAt) <
            policy.deferralReuseHours * 60 * 60 * 1000),
    )
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0];
}

export function rememberedReviewLabel(
  memory: Pick<GreenhouseReviewMemory, "decidedAt" | "outcome">,
) {
  const day = new Date(memory.decidedAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: FIELDWORK_TIMEZONE,
  });
  return `reviewed ${day} (${memory.outcome === "excluded" ? "Excluded" : "Deferred"})`;
}

/** Only the completed task's captured inputs may authorize a remembered decision. */
export function saveReviewMemory(
  store: Store,
  run: PullRun,
  candidate: PullCandidate,
  task: Task,
  decidedAt: string,
) {
  const decision = task.greenhouseDecision;
  const inputs = recoverReviewInputs(store, task);
  if (
    legacyMultiProviderPull(run) ||
    candidate.remembered ||
    task.status !== "completed" ||
    // The initial prompt is queued as a user message; any later one steered the review.
    (task.messages ?? []).filter((message) => message.role === "user").length >
      1 ||
    task.greenhousePull?.runId !== run.id ||
    task.greenhousePull.candidateId !== candidate.id ||
    candidate.taskId !== task.id ||
    !inputs ||
    !decision ||
    decision.decision === "add" ||
    !decision.reason ||
    !Number.isFinite(Date.parse(decidedAt)) ||
    !run.guidance ||
    inputs.guidance !== sha256(run.guidance.instructions) ||
    inputs.postingContent !== reviewPostingHash(candidate)
  )
    return false;
  // A missing historical guidance snapshot is not equivalent to an empty one.
  const instructions = task.greenhousePull.instructions;
  if (
    !instructions ||
    sha256(instructions) !== inputs.harvestInstructions ||
    (run.guidance.instructions &&
      !instructions.endsWith(greenhouseGuidanceInstructions(run.guidance)))
  )
    return false;
  decidedAt = new Date(decidedAt).toISOString();
  const id = reviewMemoryId(candidate);
  const previous = store.get(reviewMemoryKind, id);
  if (previous && previous.decidedAt > decidedAt) return false;
  store.put(reviewMemoryKind, id, {
    id,
    board: candidate.card.board,
    aliases: [
      ...new Set([candidate.card.id, ...(candidate.posting?.aliases ?? [])]),
    ],
    internalJobId:
      candidate.posting?.raw.internal_job_id == null
        ? undefined
        : String(candidate.posting.raw.internal_job_id),
    outcome: decision.decision,
    decidedAt,
    runId: run.id,
    candidateId: candidate.id,
    taskId: task.id,
    reason: decision.reason
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, tunable(store, "greenhouse.reviewMemoryReasonChars")),
    fingerprint: reviewFingerprint(inputs),
    postingContentHash: inputs.postingContent,
  });
  return true;
}

export function rereviewCandidate(
  store: Store,
  runId: string,
  candidateId: string,
) {
  const run = store.get("greenhouse_pull_run", runId);
  const candidate = store.get("greenhouse_pull_candidate", candidateId);
  if (!run || !candidate || candidate.runId !== run.id)
    throw new HttpError(404, "Pull candidate not found");
  return store.transaction(() => {
    // Remove equivalent advertisement memories too, or the alias would immediately restore it.
    for (const memory of store.list(reviewMemoryKind))
      if (
        memory.id === reviewMemoryId(candidate) ||
        (sameRequisition(memory, candidate) &&
          memory.postingContentHash === reviewPostingHash(candidate))
      )
        store.remove(reviewMemoryKind, memory.id);
    const requeued =
      candidate.remembered &&
      !legacyMultiProviderPull(run) &&
      (run.status === "running" || run.status === "finishing");
    const updated: PullCandidate = requeued
      ? {
          ...candidate,
          state: "discovered",
          reason: undefined,
          taskId: undefined,
          reviewed: undefined,
          remembered: undefined,
          forceReview: true,
          activityStatus: undefined,
          waitingFor: undefined,
        }
      : candidate;
    if (requeued) store.put("greenhouse_pull_candidate", candidate.id, updated);
    store.autoExport();
    return {
      candidate: updated,
      requeued: Boolean(requeued),
      memoryCleared: true,
    };
  });
}
