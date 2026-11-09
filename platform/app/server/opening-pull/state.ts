import { tunable } from "../tunables.js";
import {
  greenhousePullFinished,
  type GreenhousePullSummary,
} from "../../shared/greenhouse-pull.js";
import {
  legacyMultiProviderPull,
  type PullRun,
  type PullCandidate,
} from "../greenhouse-pull-records.js";
import type { Store } from "../storage.js";
import {
  currentGreenhouseSearch,
  greenhouseSearchCoverage,
} from "../greenhouse-query-plan.js";
import { greenhouseSearchIdentity } from "../../shared/greenhouse-search.js";
import { reviewCooldownPhase } from "../greenhouse-review-cooldown.js";
import { greenhouseReviews } from "../greenhouse-pull-scheduling.js";
import { greenhouseActivitySnapshot } from "../greenhouse-pull-activity.js";
import { runGreenhousePolicy } from "./policy.js";
import { greenhouseParallelReviews } from "../greenhouse-review-settings.js";

export function summarizePull(
  store: Store,
  r: PullRun,
  candidates: PullCandidate[],
): GreenhousePullSummary {
  const search = currentGreenhouseSearch(r);
  const current = candidates.find((c) => c.id === r.currentId);
  const count = (s: PullCandidate["state"]) =>
    candidates.filter((c) => c.state === s).length;
  const legacySources = legacyMultiProviderPull(r);
  const retiredUnfinished = legacySources && !greenhousePullFinished(r.status);
  return {
    id: r.id,
    target: r.target,
    policy: runGreenhousePolicy(r, store.settings()),
    guidance: r.guidance
      ? r.guidance.employmentScope
        ? r.guidance
        : { ...r.guidance, employmentTypes: r.guidance.employmentTypes ?? [] }
      : undefined,
    status: retiredUnfinished ? "paused" : r.status,
    phase: retiredUnfinished
      ? "This saved pull includes retired sources. Stop it and start a new Greenhouse pull; its additions and evidence are retained."
      : reviewCooldownPhase(r),
    activity: greenhouseActivitySnapshot(
      r,
      tunable(store, "greenhouse.activityPerLane"),
    ),
    discovered: candidates.length,
    reviewed: candidates.filter((c) => c.reviewed).length,
    remembered: candidates.filter((c) => c.remembered).length,
    existing: count("existing"),
    excluded: count("excluded"),
    deferred: count("deferred"),
    added: count("added"),
    pending: count("discovered") + count("reviewing"),
    ...(legacySources ? { legacySources: true } : {}),
    query: search.query,
    employmentTypes: greenhouseSearchIdentity(search).employmentTypes,
    page: r.page,
    parallelReviews: r.parallelReviews,
    effectiveParallelReviews: greenhouseParallelReviews(store),
    searchLookahead: r.searchLookahead,
    pacingRate: r.pacingRate,
    initialPacingRate: r.initialPacingRate,
    finalPacingRate: r.finalPacingRate,
    searchTransport: r.searchTransport,
    searchTransportNote: r.searchTransportNote,
    currentTitle: current
      ? `${current.card.company} · ${current.card.title}`
      : undefined,
    taskId: current?.taskId,
    reviews: greenhouseReviews(store, candidates),
    searches:
      !r.providers || r.providers.includes("greenhouse")
        ? greenhouseSearchCoverage(r)
        : [],
    retryAt: retiredUnfinished ? undefined : r.retryAt,
    error: r.error,
    addedOpeningIds: candidates
      .filter((c) => c.state === "added")
      .map((c) => c.openingId!),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
