import {
  greenhouseDefaultParallelReviews,
  greenhouseParallelReviewBounds,
  greenhouseFormulaSearchLookahead,
  greenhouseSearchLookaheadBounds,
} from "../shared/greenhouse-pull.js";
import { HttpError, type Store } from "./storage.js";
import type { PullRun } from "./greenhouse-pull-records.js";

export function validateGreenhouseParallelReviews(value: unknown): number {
  const { min, max } = greenhouseParallelReviewBounds;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new HttpError(
      400,
      `Parallel reviews must be a whole number from ${min} to ${max}`,
    );
  return value;
}

export function greenhouseParallelReviews(store: Store) {
  const saved = store.settings().parallelReviews;
  const { min, max } = greenhouseParallelReviewBounds;
  return typeof saved === "number" &&
    Number.isInteger(saved) &&
    saved >= min &&
    saved <= max
    ? saved
    : greenhouseDefaultParallelReviews;
}

export function validateGreenhouseFormCheckNewOpenings(
  value: unknown,
): boolean {
  if (typeof value !== "boolean")
    throw new HttpError(
      400,
      "Form check for new openings must be true or false",
    );
  return value;
}

export const formCheckNewOpenings = (store: Store) =>
  store.settings().greenhouseFormCheckNewOpenings !== false;

export function validateGreenhouseSearchLookahead(value: unknown): number {
  const { min, max } = greenhouseSearchLookaheadBounds;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new HttpError(
      400,
      `Search lookahead must be a whole number from ${min} to ${max}`,
    );
  return value;
}

export function greenhouseSearchLookahead(store: Store) {
  const saved = store.settings().greenhouseSearchLookahead;
  const { min, max } = greenhouseSearchLookaheadBounds;
  return typeof saved === "number" &&
    Number.isInteger(saved) &&
    saved >= min &&
    saved <= max
    ? saved
    : greenhouseFormulaSearchLookahead(greenhouseParallelReviews(store));
}

/** Retain live scheduling values without rewriting prior decisions. */
export function recordGreenhouseParallelReviews(
  store: Store,
  run: PullRun,
  at: number,
  notify: () => void,
): PullRun {
  const parallelReviews = greenhouseParallelReviews(store);
  const searchLookahead = greenhouseSearchLookahead(store);
  const parallelChanged =
    run.parallelReviews !== parallelReviews ||
    !run.parallelReviewChanges?.length;
  const lookaheadChanged =
    run.searchLookahead !== searchLookahead ||
    !run.searchLookaheadChanges?.length;
  if (!parallelChanged && !lookaheadChanged) return run;
  const updatedAt = new Date(at).toISOString();
  const saved: PullRun = {
    ...run,
    parallelReviews,
    searchLookahead,
    parallelReviewChanges: parallelChanged
      ? [
          ...(run.parallelReviewChanges ?? []),
          { at: updatedAt, parallelReviews },
        ]
      : run.parallelReviewChanges,
    searchLookaheadChanges: lookaheadChanged
      ? [
          ...(run.searchLookaheadChanges ?? []),
          { at: updatedAt, searchLookahead },
        ]
      : run.searchLookaheadChanges,
    updatedAt,
  };
  store.put("greenhouse_pull_run", run.id, saved);
  store.autoExport();
  notify();
  return saved;
}
