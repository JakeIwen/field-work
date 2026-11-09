import {
  greenhouseDefaultPacingMs,
  greenhouseDefaultPacingPenaltyMs,
  greenhouseDriverIntervalBounds,
} from "../shared/greenhouse-search.js";
import { tunable, tunableMs } from "./tunables.js";
import { HttpError, type Store } from "./storage.js";
import type { PullRun } from "./greenhouse-pull-records.js";
import { currentGreenhouseSearch } from "./greenhouse-query-plan.js";
import {
  appendGreenhouseActivity,
  greenhouseActivityText,
} from "./greenhouse-pull-activity.js";
import {
  greenhouseActivityLane,
  greenhouseActivityLevel,
} from "../shared/greenhouse-pull.js";

export function validateGreenhousePacing(value: unknown): number {
  const { min, max } = greenhouseDriverIntervalBounds;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new HttpError(
      400,
      "Page interval must be whole milliseconds from 1000 to 60000",
    );
  return value;
}

export function validateGreenhousePacingPenalty(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new HttpError(
      400,
      "Adaptive delay must be non-negative whole milliseconds",
    );
  return value;
}

export function greenhousePacingPenalty(store: Store) {
  const saved = store.settings().greenhousePacingPenaltyMs;
  return typeof saved === "number" && Number.isSafeInteger(saved) && saved >= 0
    ? saved
    : greenhouseDefaultPacingPenaltyMs;
}

export function greenhousePacingFloor(store: Store) {
  const saved = store.settings().greenhousePacingRate;
  return typeof saved === "number" &&
    Number.isSafeInteger(saved) &&
    saved >= greenhouseDriverIntervalBounds.min
    ? saved
    : greenhouseDefaultPacingMs;
}

export function greenhousePacingRate(store: Store) {
  return greenhousePacingFloor(store) + greenhousePacingPenalty(store);
}

function increaseGreenhousePacing(store: Store, current: number) {
  const settings = store.settings();
  const step = tunableMs(store, "greenhouse.pacingStepMs");
  store.put("settings", "main", {
    ...settings,
    greenhousePacingPenaltyMs: greenhousePacingPenalty(store) + step,
    version: settings.version + 1,
  });
  // Manual floor edits apply to the next pull, not this run's captured interval.
  return current + step;
}

function capturedGreenhousePacingFloor(store: Store, run: PullRun) {
  return (
    run.pacingFloorMs ??
    Math.max(
      greenhouseDriverIntervalBounds.min,
      (run.pacingRate ?? greenhousePacingRate(store)) -
        greenhousePacingPenalty(store),
    )
  );
}

export function recordGreenhousePacingIncrease(
  store: Store,
  run: PullRun,
  error: unknown,
  at: number,
) {
  const { query, employmentTypes } = currentGreenhouseSearch(run);
  const from = run.pacingRate ?? greenhousePacingRate(store);
  const pacingFloorMs = capturedGreenhousePacingFloor(store, run);
  const pacingRate = increaseGreenhousePacing(store, from);
  return {
    activity: appendGreenhouseActivity(
      run,
      {
        lane: greenhouseActivityLane.search,
        level: greenhouseActivityLevel.warn,
        text: `Page interval ${from / 1000} s → ${pacingRate / 1000} s after ${greenhouseActivityText(error)}`,
      },
      at,
    ).activity,
    pacingRate,
    pacingFloorMs,
    pacingCleanPages: 0,
    initialPacingRate: run.initialPacingRate ?? from,
    pacingIncreases: [
      ...(run.pacingIncreases ?? []),
      {
        query,
        employmentTypes,
        at: new Date(at).toISOString(),
        page: run.page,
        error: String(error),
        from,
        to: pacingRate,
      },
    ],
  };
}

export function recordGreenhousePacingRecovery(
  store: Store,
  run: PullRun,
  at: number,
): PullRun {
  const recoveryPages = tunable(store, "greenhouse.pacingRecoveryPages");
  const pacingCleanPages = (run.pacingCleanPages ?? 0) + 1;
  const pacingFloorMs = capturedGreenhousePacingFloor(store, run);
  if (pacingCleanPages < recoveryPages)
    return { ...run, pacingFloorMs, pacingCleanPages };
  const penalty = greenhousePacingPenalty(store);
  const from = run.pacingRate ?? greenhousePacingRate(store);
  const reduction = Math.min(
    Math.max(0, from - pacingFloorMs),
    tunableMs(store, "greenhouse.pacingStepMs"),
  );
  if (!reduction) return { ...run, pacingFloorMs, pacingCleanPages: 0 };
  const pacingRate = from - reduction;
  if (penalty > 0) {
    const settings = store.settings();
    store.put("settings", "main", {
      ...settings,
      greenhousePacingPenaltyMs: Math.max(0, penalty - reduction),
      version: settings.version + 1,
    });
  }
  const { query, employmentTypes } = currentGreenhouseSearch(run);
  return {
    ...appendGreenhouseActivity(
      run,
      {
        lane: greenhouseActivityLane.search,
        level: greenhouseActivityLevel.info,
        text: `Page interval ${from / 1000} s → ${pacingRate / 1000} s after ${recoveryPages} clean pages`,
      },
      at,
    ),
    pacingRate,
    pacingFloorMs,
    pacingCleanPages: 0,
    initialPacingRate: run.initialPacingRate ?? from,
    pacingDecreases: [
      ...(run.pacingDecreases ?? []),
      {
        query,
        employmentTypes,
        at: new Date(at).toISOString(),
        page: run.page,
        from,
        to: pacingRate,
      },
    ],
  };
}
