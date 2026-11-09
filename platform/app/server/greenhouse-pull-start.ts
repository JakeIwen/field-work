import { greenhouseCardDateMarginDays } from "../shared/greenhouse-policy.js";
import { tunable } from "./tunables.js";
import { randomUUID } from "node:crypto";
import type { Store } from "./storage.js";
import type { PullRun } from "./greenhouse-pull-records.js";
import { captureGreenhousePolicy } from "./opening-pull/policy.js";
import { captureGreenhouseGuidance } from "./opening-pull/guidance.js";
import { rememberGreenhouseGuidance } from "./opening-pull/guidance-history.js";
import { newGreenhouseQueryPlan } from "./greenhouse-query-plan.js";
import {
  greenhousePacingFloor,
  greenhousePacingRate,
} from "./greenhouse-pacing.js";

/** The record a new pull starts from: it freezes the saved guidance, selection
 * policy and pacing so later Settings edits change only later pulls, and plans
 * its searches after the previous run's rotation. */
export function newGreenhousePullRun(
  store: Store,
  target: number,
  clientRequestId: string,
  previous: PullRun | undefined,
  now: number,
): PullRun {
  const at = new Date(now).toISOString();
  const guidance = captureGreenhouseGuidance(store);
  const policy = captureGreenhousePolicy(store.settings(), at);
  const cardDateMarginDays = tunable(store, "greenhouse.cardDateMarginDays");
  rememberGreenhouseGuidance(store, guidance.instructions, at);
  return {
    id: randomUUID(),
    target,
    clientRequestId,
    status: "running",
    phase: "Starting Greenhouse search",
    queryIndex: 0,
    page: 1,
    guidance,
    policy: {
      ...policy,
      ...(cardDateMarginDays !== greenhouseCardDateMarginDays
        ? { cardDateMarginDays }
        : {}),
    },
    pacingRate: greenhousePacingRate(store),
    initialPacingRate: greenhousePacingRate(store),
    pacingFloorMs: greenhousePacingFloor(store),
    queryPlan: newGreenhouseQueryPlan(
      previous,
      guidance.searchTerms,
      guidance.employmentScope,
      policy.regularSearchTerms,
    ),
    reviewCursor: 0,
    cutoff: new Date(now - policy.freshnessDays * 86400000).toISOString(),
    activity: [],
    pages: [],
    failures: [],
    limitCount: 0,
    createdAt: at,
    updatedAt: at,
  };
}
