import type { GreenhouseSearch } from "../shared/greenhouse-search.js";
import type {
  GreenhousePullStatus,
  GreenhouseActivity,
  GreenhouseFinishReason,
} from "../shared/greenhouse-pull.js";
import type { OpeningPullProvider } from "../shared/opening-pull.js";
import type { GreenhouseCard, GreenhousePosting } from "./greenhouse-source.js";

export type PullCandidate = {
  id: string;
  runId: string;
  card: GreenhouseCard;
  state:
    "discovered" | "reviewing" | "existing" | "excluded" | "deferred" | "added";
  reason?: string;
  posting?: GreenhousePosting;
  taskId?: string;
  activityStatus?: import("../shared/types.js").TaskStatus;
  openingId?: string;
  reviewed?: boolean;
  remembered?: {
    memoryId: string;
    decidedAt: string;
    outcome: "excluded" | "deferred";
  };
  forceReview?: boolean;
  attempts?: string[];
  waitingFor?: string;
  discoveredBy?: string[];
  reviewSelection?: Partial<
    import("../shared/model-selection.js").ModelSelection
  >;
};
export type PullQueryCursor = GreenhouseSearch & {
  page: number;
  exhausted: boolean;
};
export type PullRun = {
  // Retained only to identify historical runs that cannot resume retired sources.
  providers?: OpeningPullProvider[];
  id: string;
  target: number;
  guidance?: import("../shared/greenhouse-guidance.js").GreenhouseGuidance;
  policy?: import("../shared/greenhouse-policy.js").CapturedGreenhousePolicy;
  clientRequestId: string;
  status: GreenhousePullStatus;
  phase: string;
  activity?: GreenhouseActivity[];
  queryIndex: number;
  page: number;
  parallelReviews?: number;
  parallelReviewChanges?: import("../shared/greenhouse-pull.js").GreenhouseParallelReviewUse[];
  searchLookahead?: number;
  searchLookaheadChanges?: import("../shared/greenhouse-pull.js").GreenhouseSearchLookaheadUse[];
  pacingRate?: number;
  pacingFloorMs?: number;
  searchNonce?: string;
  initialPacingRate?: number;
  finalPacingRate?: number;
  pacingIncreases?: import("../shared/greenhouse-search.js").GreenhousePacingIncrease[];
  pacingDecreases?: import("../shared/greenhouse-search.js").GreenhousePacingDecrease[];
  pacingCleanPages?: number;
  searchTransport?: import("../shared/greenhouse-search.js").GreenhouseSearchTransport;
  searchTransportNote?: string;
  activityTransportNote?: string;
  queryPlan?: PullQueryCursor[];
  reviewCursor?: number;
  cutoff: string;
  currentId?: string;
  retryAt?: string;
  retryCandidateId?: string;
  error?: string;
  limitCount: number;
  bridgeFailureCount?: number;
  reviewCooldown?: {
    retryAt: string;
    failures: number;
    candidateId: string;
    error: string;
  };
  finishReviews?: boolean;
  finishReason?: GreenhouseFinishReason;
  searchRetry?: GreenhouseSearch & { page: number; attempts: number };
  // The next page stays pending when discovery pauses at its backlog bound.
  searchInProgress?: boolean;
  pages: (GreenhouseSearch & {
    pacingRate?: number;
    page: number;
    ids: string[];
    more: boolean;
    at: string;
    status: number;
  })[];
  failures: (GreenhouseSearch & {
    at: string;
    page: number;
    candidateId?: string;
    error: string;
    retryAt?: string;
  })[];
  createdAt: string;
  updatedAt: string;
};

export const greenhouseReviewFinishing = (run: PullRun) =>
  run.status === "finishing" ||
  (run.status === "stopped" && run.finishReviews === true);

export const greenhouseReviewPublicationAllowed = (run: PullRun) =>
  run.status === "running" || greenhouseReviewFinishing(run);

export const legacyMultiProviderPull = (run: PullRun) =>
  run.providers?.some((provider) => provider !== "greenhouse") ?? false;
