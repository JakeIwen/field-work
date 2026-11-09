import {
  tunables,
  tunableValue,
  type TunableSettings,
} from "../shared/tunables.js";
import {
  GreenhouseLimit,
  GreenhouseBridgeTransient,
} from "./greenhouse-source.js";
import { currentGreenhouseSearch } from "./greenhouse-query-plan.js";
import { GreenhouseSearchTransient } from "./greenhouse-search.js";
import type { PullRun } from "./greenhouse-pull-records.js";
import { greenhouseFailureActivity } from "./greenhouse-pull-activity.js";

// A disconnected browser needs operator attention after bounded automatic recovery.
export const greenhouseBridgeFailureLimit =
  tunables["greenhouse.bridgeFailuresBeforeStop"].default;

export const greenhouseSearchRateError = (run: PullRun, error: unknown) =>
  !run.currentId &&
  run.searchInProgress === true &&
  (error instanceof GreenhouseLimit ||
    error instanceof GreenhouseSearchTransient);

export function greenhousePullFailure(
  run: PullRun,
  error: unknown,
  at: number,
  settings: TunableSettings = {},
): PullRun {
  const baseCooldownMs =
    tunableValue(settings, "greenhouse.baseCooldownS") * 1000;
  const maximumCooldownMultiplier = tunableValue(
    settings,
    "greenhouse.cooldownMultiplierCap",
  );
  const { query, employmentTypes } = currentGreenhouseSearch(run);
  let retryAt: string | undefined;
  let limitCount = run.limitCount;
  let phase = "Needs attention. Saved progress is retained.";
  const bridgeFailure =
    !run.currentId &&
    run.searchInProgress === true &&
    error instanceof GreenhouseBridgeTransient;
  const bridgeFailureCount = bridgeFailure
    ? (run.bridgeFailureCount ?? 0) + 1
    : 0;
  if (bridgeFailure) {
    phase =
      "Chrome connection failed. Check the configured browser bridge service and its health endpoint, then resume.";
    if (
      bridgeFailureCount <
      tunableValue(settings, "greenhouse.bridgeFailuresBeforeStop")
    ) {
      retryAt = new Date(
        at +
          baseCooldownMs *
            Math.min(maximumCooldownMultiplier, 2 ** (bridgeFailureCount - 1)),
      ).toISOString();
      phase =
        "Chrome connection interrupted. Cooling down before retrying the same page; search interval unchanged.";
    }
  } else if (
    error instanceof GreenhouseLimit ||
    greenhouseSearchRateError(run, error)
  ) {
    retryAt = new Date(
      Math.max(
        error instanceof GreenhouseLimit ? Date.parse(error.retryAt) : 0,
        at +
          baseCooldownMs *
            Math.min(maximumCooldownMultiplier, 2 ** run.limitCount),
      ),
    ).toISOString();
    limitCount++;
    phase = greenhouseSearchRateError(run, error)
      ? "Search error. Cooling down before retrying the same page at a slower interval."
      : "Rate limited. Waiting before retrying the same request.";
  }
  return {
    ...greenhouseFailureActivity(run, error, retryAt, bridgeFailure, at),
    status: retryAt ? "cooldown" : "failed",
    error: String(error),
    retryAt,
    limitCount,
    bridgeFailureCount,
    phase,
    retryCandidateId: run.currentId,
    searchRetry: undefined,
    failures: [
      ...run.failures,
      {
        at: new Date(at).toISOString(),
        query,
        employmentTypes,
        page: run.page,
        candidateId: run.currentId,
        error: String(error),
        retryAt,
      },
    ],
  };
}
