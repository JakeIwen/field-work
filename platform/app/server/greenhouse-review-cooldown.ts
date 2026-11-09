import type { ModelSelection } from "../shared/model-selection.js";
import { configuredEffort } from "../shared/codex-models.js";
import { isTaskBusy, isTaskWaiting } from "../shared/types.js";
import type { Task } from "../shared/task-records.js";
import type { Store } from "./storage.js";
import {
  greenhouseReviewPublicationAllowed,
  greenhouseReviewFinishing,
  type PullRun,
  type PullCandidate,
} from "./greenhouse-pull-records.js";
import { currentGreenhouseSearch } from "./greenhouse-query-plan.js";
import { pullResearchRequest } from "./greenhouse-research.js";
import {
  appendGreenhouseActivity,
  retainGreenhouseActivity,
} from "./greenhouse-pull-activity.js";

import { tunableMs } from "./tunables.js";
const capacityError =
  /\bat (?:full )?capacity\b|\boverloaded(?:_error)?\b|\boverload_error\b|\brate[ _-]limit(?:ed|ing|[ _-](?:exceeded|error|reached))?\b|\btoo many requests\b|\btry again later\b|(?:\b(?:http|status|error|code)["']?\s*[:=]?\s*["']?|^)(?:429|529)\b/i;

export type ReviewServices = {
  createResearch: (
    run: PullRun,
    candidate: PullCandidate,
  ) => Promise<Task | undefined>;
  startTask: (
    id: string,
    selection?: Partial<ModelSelection>,
  ) => Promise<unknown>;
  notify: () => void;
  defaultModel?: () => string | undefined;
};

export const reviewCooldownActive = (run: PullRun, at: number) =>
  Boolean(run.reviewCooldown && Date.parse(run.reviewCooldown.retryAt) > at);

export function reviewStartBlocked(
  store: Store,
  run: PullRun,
  candidate: PullCandidate,
  at: number,
) {
  if (!reviewCooldownActive(run, at)) return false;
  if (candidate.state === "discovered") return true;
  const task = candidate.taskId && store.get("task", candidate.taskId);
  return Boolean(
    (!candidate.taskId && candidate.attempts?.length) ||
    (task && !task.threadId && ["handoff", "queued"].includes(task.status)),
  );
}

export function reviewCooldownPhase(run: PullRun) {
  if (!run.reviewCooldown || !greenhouseReviewPublicationAllowed(run))
    return run.phase;
  return `${run.phase} Review starts retry after ${run.reviewCooldown.retryAt} (model capacity; same model).`;
}

function createdReviewTask(store: Store, candidate: PullCandidate) {
  if (candidate.taskId) return store.get("task", candidate.taskId);
  const row = store.db
    .prepare(
      "SELECT json FROM records WHERE kind='task' AND json_extract(json, '$.clientRequestId')=? ORDER BY rowid DESC LIMIT 1",
    )
    .get(pullResearchRequest(candidate).clientRequestId) as
    { json: string } | undefined;
  return row ? (JSON.parse(row.json) as Task) : undefined;
}

function captureReviewSelection(
  store: Store,
  candidate: PullCandidate,
  task?: Task,
  defaultModel?: string,
) {
  const settings = store.settings();
  const selection = {
    model:
      task?.model ||
      (candidate.reviewSelection
        ? candidate.reviewSelection.model
        : settings.codexModels?.["greenhouse-pull"]) ||
      defaultModel,
    effort:
      task?.effort ||
      candidate.reviewSelection?.effort ||
      configuredEffort(settings.codexEfforts, "greenhouse-pull"),
  };
  candidate.reviewSelection = selection;
  const saved = store.get("greenhouse_pull_candidate", candidate.id);
  if (saved)
    store.put("greenhouse_pull_candidate", saved.id, {
      ...saved,
      reviewSelection: selection,
    });
  return selection;
}

function reviewCooldownDelay(store: Store, failures: number) {
  return Math.min(
    tunableMs(store, "greenhouse.reviewCooldownMaxMin"),
    tunableMs(store, "greenhouse.reviewCooldownInitialS") * 2 ** (failures - 1),
  );
}

export function deferReviewForCapacity(
  store: Store,
  run: PullRun,
  candidate: PullCandidate,
  error: unknown,
  at: number,
  creating = false,
) {
  if (!capacityError.test(String(error))) return false;
  const current = store.get("greenhouse_pull_run", run.id);
  const saved = store.get("greenhouse_pull_candidate", candidate.id);
  if (
    !current ||
    !saved ||
    !(
      current.status === "paused" || greenhouseReviewPublicationAllowed(current)
    ) ||
    !["discovered", "reviewing"].includes(saved.state)
  )
    return false;
  const task = createdReviewTask(store, saved);
  if (task?.status === "completed") return false;
  const failures = (current.reviewCooldown?.failures ?? 0) + 1;
  const delay = reviewCooldownDelay(store, failures);
  const retryAt = new Date(at + delay).toISOString();
  store.transaction(() => {
    const selection = captureReviewSelection(store, saved, task);
    requeueReview(
      store,
      saved,
      task,
      String(error),
      creating,
      selection,
      greenhouseReviewFinishing(current),
    );
    const { query, employmentTypes } = currentGreenhouseSearch(current);
    const logged = appendGreenhouseActivity(
      current,
      {
        lane: "review",
        level: "warn",
        text: `Codex model at capacity: ${saved.card.company} · ${saved.card.title} waits ${Math.round(delay / 1000)} s`,
        candidateId: saved.id,
      },
      at,
    );
    store.put("greenhouse_pull_run", current.id, {
      ...retainGreenhouseActivity(store, logged),
      reviewCooldown: {
        failures,
        retryAt,
        candidateId: saved.id,
        error: String(error),
      },
      currentId: undefined,
      retryCandidateId: undefined,
      error: undefined,
      phase:
        current.status !== "running"
          ? current.phase
          : "Model capacity is temporarily limiting review starts. Existing reviews and searches can continue.",
      failures: [
        ...current.failures,
        {
          query,
          employmentTypes,
          page: current.page,
          candidateId: saved.id,
          at: new Date(at).toISOString(),
          error: String(error),
          retryAt,
        },
      ],
      updatedAt: new Date(at).toISOString(),
    });
  });
  store.autoExport();
  return true;
}

export function failedReview(
  store: Store,
  run: PullRun,
  candidate: PullCandidate,
  task: Task,
  at: number,
  notify: () => void,
) {
  if (!deferReviewForCapacity(store, run, candidate, task.error, at))
    throw Error(
      task.error ||
        `Codex review ${task.status}. Resume to retry this candidate.`,
    );
  notify();
  return { kind: "done" as const };
}

function requeueReview(
  store: Store,
  candidate: PullCandidate,
  task: Task | undefined,
  error: string,
  creating: boolean,
  selection: Partial<ModelSelection>,
  retainReservation: boolean,
) {
  const running =
    task?.threadId && (isTaskBusy(task.status) || isTaskWaiting(task.status));
  const reusable = task && !task.threadId && (!creating || task.manifest);
  if (reusable)
    store.put("task", task.id, {
      ...task,
      status: "handoff",
      error,
      version: (task.version ?? 0) + 1,
    });
  store.put("greenhouse_pull_candidate", candidate.id, {
    ...candidate,
    reviewSelection: selection,
    state:
      running || reusable || retainReservation ? "reviewing" : "discovered",
    taskId: running || reusable ? task?.id : undefined,
    ...(!running && !reusable && task
      ? { attempts: [...new Set([...(candidate.attempts ?? []), task.id])] }
      : {}),
  });
}

async function createReview(
  store: Store,
  services: ReviewServices,
  run: PullRun,
  candidate: PullCandidate,
  clock: () => number,
) {
  captureReviewSelection(
    store,
    candidate,
    undefined,
    services.defaultModel?.(),
  );
  try {
    return await services.createResearch(run, candidate);
  } catch (error) {
    if (!deferReviewForCapacity(store, run, candidate, error, clock(), true))
      throw error;
    services.notify();
    return undefined;
  }
}

async function startReview(
  store: Store,
  services: ReviewServices,
  id: string,
  clock: () => number,
) {
  const task = store.get("task", id);
  const run =
    task?.greenhousePull &&
    store.get("greenhouse_pull_run", task.greenhousePull.runId);
  const candidate =
    task?.greenhousePull &&
    store.get("greenhouse_pull_candidate", task.greenhousePull.candidateId);
  if (!task || !run || !candidate) return services.startTask(id);
  try {
    const result = await services.startTask(
      id,
      captureReviewSelection(store, candidate, task, services.defaultModel?.()),
    );
    const saved = store.get("task", id);
    captureReviewSelection(store, candidate, saved, services.defaultModel?.());
    if (
      saved &&
      !isTaskBusy(saved.status) &&
      !isTaskWaiting(saved.status) &&
      !["handoff", "completed"].includes(saved.status) &&
      deferReviewForCapacity(store, run, candidate, saved.error, clock())
    )
      services.notify();
    else if (
      saved?.threadId &&
      (isTaskBusy(saved.status) ||
        isTaskWaiting(saved.status) ||
        saved.status === "completed")
    ) {
      const current = store.get("greenhouse_pull_run", run.id);
      if (current?.reviewCooldown) {
        store.put("greenhouse_pull_run", run.id, {
          ...current,
          reviewCooldown: undefined,
        });
        store.autoExport();
        services.notify();
      }
    }
    return result;
  } catch (error) {
    captureReviewSelection(
      store,
      candidate,
      store.get("task", id),
      services.defaultModel?.(),
    );
    if (!deferReviewForCapacity(store, run, candidate, error, clock()))
      throw error;
    services.notify();
    return undefined;
  }
}

export function withReviewCooldown<T extends ReviewServices>(
  store: Store,
  services: T,
  clock: () => number,
) {
  return {
    ...services,
    createResearch: (run: PullRun, candidate: PullCandidate) =>
      createReview(store, services, run, candidate, clock),
    startTask: (id: string) => startReview(store, services, id, clock),
  };
}
