import {
  openingPullDateLabels,
  type OpeningSourceDate,
  type OpeningPullSource,
} from "../../shared/opening-pull.js";
import { validOpeningDate } from "../../shared/opening-assessments.js";
import type { PullRun, PullCandidate } from "../greenhouse-pull-records.js";
import { type PullPosting } from "./contract.js";

import {
  defaultGreenhousePullPolicy,
  greenhouseCardDateMarginDays,
} from "../../shared/greenhouse-policy.js";

export const pullFreshnessDays = defaultGreenhousePullPolicy.freshnessDays;
export const pullFreshnessWindow = pullFreshnessDays * 86400000;
export const pullSearchDateMarginDays = greenhouseCardDateMarginDays;
export const pullSearchDateWindow =
  (pullFreshnessDays + pullSearchDateMarginDays) * 86400000;

export function oldPullSearchDate(
  candidate: PullCandidate,
  at: number,
  freshnessDays = pullFreshnessDays,
  cardDateMarginDays: number = greenhouseCardDateMarginDays,
) {
  const date = candidate.card.firstPublished;
  return Boolean(
    date &&
    validOpeningDate(date) &&
    Date.parse(date) < at - (freshnessDays + cardDateMarginDays) * 86400000,
  );
}
export function pullPostingDate(posting: PullPosting): OpeningSourceDate {
  return {
    kind: "original-publication",
    value:
      typeof posting.raw.first_published === "string"
        ? posting.raw.first_published
        : null,
    source: posting.apiUrl,
    fetchedAt: posting.fetchedAt,
  };
}
export function pullDateDisposition(
  run: PullRun,
  posting: PullPosting,
  at: number,
): { state: "deferred" | "excluded"; reason: string } | undefined {
  const date = pullPostingDate(posting),
    label = openingPullDateLabels.greenhouse;
  const published =
    date.value && validOpeningDate(date.value) ? Date.parse(date.value) : NaN;
  if (!Number.isFinite(published))
    return {
      state: "deferred",
      reason: `Official API has no usable ${label.toLowerCase()} date. Freshness cannot be established.`,
    };
  if (
    published <
      Math.max(
        Date.parse(run.cutoff),
        at - (run.policy?.freshnessDays ?? pullFreshnessDays) * 86400000,
      ) ||
    published > at
  )
    return {
      state: "excluded",
      reason: `${label} is outside the ${run.policy ? `${run.policy.freshnessDays}-day` : "seven-day"} window or in the future. This is not an Added date.`,
    };
}
export function pullOpeningProvenance(
  run: PullRun,
  candidate: PullCandidate,
  posting: PullPosting,
) {
  const pullSource: OpeningPullSource = {
    provider: "greenhouse",
    board: candidate.card.board,
    postingId: candidate.card.id,
    region: "global",
    apiUrl: posting.apiUrl,
    pullId: run.id,
    date: pullPostingDate(posting),
  };
  const internalId = posting.raw.internal_job_id;
  return {
    pullSource,
    greenhouse: {
      board: candidate.card.board,
      publicId: candidate.card.id,
      internalJobId:
        typeof internalId === "string" || typeof internalId === "number"
          ? internalId
          : null,
      aliases: posting.aliases,
      apiUrl: posting.apiUrl,
      pullId: run.id,
    },
    greenhouseAliases: posting.aliases,
  };
}
