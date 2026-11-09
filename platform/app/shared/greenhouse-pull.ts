import { tunables } from "./tunables-registry.js";
import type { GreenhouseSearch } from "./greenhouse-search.js";
import type { TaskStatus } from "./types.js";

export const greenhouseDefaultParallelReviews = 6;
export const greenhouseParallelReviewBounds = { min: 1, max: 10 } as const;
export const greenhouseSearchLookaheadBounds = { min: 1, max: 40 } as const;
export const greenhouseFormulaSearchLookahead = (parallelReviews: number) =>
  parallelReviews;
export type GreenhouseReviewSettings = {
  parallelReviews?: number;
  greenhouseSearchLookahead?: number;
  /** Absent means on: pulls enqueue a form question check for each new Opening. */
  greenhouseFormCheckNewOpenings?: boolean;
};
export type GreenhouseSearchLookaheadUse = {
  at: string;
  searchLookahead: number;
};
export type GreenhouseParallelReviewUse = {
  at: string;
  parallelReviews: number;
};

export const greenhouseActivityLane = {
  search: "search",
  review: "review",
} as const;
export const greenhouseActivityLevel = {
  info: "info",
  warn: "warn",
  error: "error",
} as const;
export type GreenhouseActivity = {
  at: string;
  lane: (typeof greenhouseActivityLane)[keyof typeof greenhouseActivityLane];
  level: (typeof greenhouseActivityLevel)[keyof typeof greenhouseActivityLevel];
  text: string;
  candidateId?: string;
  remembered?: boolean;
  triagePage?: string;
  taskId?: string;
};
export const greenhouseActivityLimit =
  tunables["greenhouse.activityPerRun"].default;
export const greenhouseActivityLaneLimit =
  tunables["greenhouse.activityPerLane"].default;

export type GreenhouseFinishReason = "target" | "stop";

export type GreenhousePullStatus =
  | "finishing"
  | "running"
  | "cooldown"
  | "paused"
  | "failed"
  | "target_reached"
  | "exhausted"
  | "stopped";
export type GreenhousePullSummary = GreenhouseSearch & {
  id: string;
  target: number;
  guidance?: import("./greenhouse-guidance.js").GreenhouseGuidance;
  policy?: import("./greenhouse-policy.js").CapturedGreenhousePolicy;
  status: GreenhousePullStatus;
  phase: string;
  activity?: GreenhouseActivity[];
  discovered: number;
  reviewed: number;
  remembered?: number;
  existing: number;
  excluded: number;
  deferred: number;
  added: number;
  pending: number;
  page: number;
  parallelReviews?: number;
  effectiveParallelReviews?: number;
  searchLookahead?: number;
  pacingRate?: number;
  initialPacingRate?: number;
  finalPacingRate?: number;
  searchTransport?: import("./greenhouse-search.js").GreenhouseSearchTransport;
  searchTransportNote?: string;
  currentTitle?: string;
  taskId?: string;
  reviews?: { taskId: string; title: string; status: TaskStatus }[];
  searches?: (GreenhouseSearch & { pages: number; exhausted: boolean })[];
  legacySources?: boolean;
  retryAt?: string;
  error?: string;
  addedOpeningIds: string[];
  createdAt: string;
  updatedAt: string;
};
export const greenhousePullBlocksNewRun = (status: GreenhousePullStatus) =>
  status !== "finishing" && !greenhousePullFinished(status);

export const greenhousePullFinished = (status: GreenhousePullStatus) =>
  ["target_reached", "exhausted", "stopped"].includes(status);
