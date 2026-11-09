import { oldPullSearchDate } from "./dates.js";
import { greenhouseCardDateMarginDays } from "../../shared/greenhouse-policy.js";
import { greenhousePolicyFitCriteria, runGreenhousePolicy } from "./policy.js";
import { excludedGreenhouseCompany } from "../../shared/greenhouse-company-filter.js";
import type { Opening } from "../../shared/types.js";
import type { PullCandidate, PullRun } from "../greenhouse-pull-records.js";
import { greenhouseSearchIdentity } from "../../shared/greenhouse-search.js";
import type { GreenhousePage } from "../greenhouse-search.js";
import type { Store } from "../storage.js";
import { existingGreenhouseOpening } from "./identity.js";
import { pullTitleExclusion } from "./title-triage.js";

type CardDisposition = {
  state: PullCandidate["state"];
  reason: string;
  openingId?: string;
};

export function greenhouseCompanyDisposition(
  store: Store,
  candidate: PullCandidate,
  policy = runGreenhousePolicy(
    store.get("greenhouse_pull_run", candidate.runId),
    store.settings(),
  ),
): CardDisposition | undefined {
  const task = candidate.taskId
    ? store.get("task", candidate.taskId)
    : undefined;
  if (
    (candidate.state === "discovered" ||
      (task &&
        !task.threadId &&
        ["handoff", "queued"].includes(task.status))) &&
    excludedGreenhouseCompany(
      // Live additions are the user's explicit stop control; removing a captured company
      // must not widen a running pull. Already-started reviews remain untouched.
      [
        ...policy.excludedCompanies,
        ...(store.settings().greenhouseExcludedCompanies ?? []),
      ],
      candidate.card.company,
      candidate.card.board,
    )
  )
    return {
      state: "excluded",
      reason: `Company filter: “${candidate.card.company}” is on your excluded companies list.`,
    };
}

/** Discovery batches and legacy candidate guards use the same decision order. */
export function greenhouseCardDisposition(
  store: Store,
  candidate: PullCandidate,
  openings?: Opening[],
  at = Date.now(),
  policy = runGreenhousePolicy(
    store.get("greenhouse_pull_run", candidate.runId),
    store.settings(),
  ),
): CardDisposition | undefined {
  const cardDateMarginDays =
    policy.cardDateMarginDays ?? greenhouseCardDateMarginDays;
  const existing = existingGreenhouseOpening(
    store,
    candidate.card,
    candidate.posting,
    openings,
  );
  if (existing)
    return {
      state: "existing",
      reason:
        "Already saved in Fieldwork (including closed/dismissed records or another advertisement of the same requisition).",
      openingId: existing.id,
    };
  const company = greenhouseCompanyDisposition(store, candidate, policy);
  if (company) return company;
  if (
    candidate.state === "discovered" &&
    !candidate.posting &&
    !candidate.taskId
  ) {
    if (
      oldPullSearchDate(candidate, at, policy.freshnessDays, cardDateMarginDays)
    )
      return {
        state: "excluded",
        reason: `Older than ${policy.freshnessDays + cardDateMarginDays} days by search date`,
      };
    const reason = pullTitleExclusion(
      candidate.card.title,
      greenhousePolicyFitCriteria(policy),
      policy.titleTriage,
    );
    if (reason) return { state: "excluded", reason };
  }
}

export type GreenhouseBatchTriage = {
  new: number;
  title: number;
  old: number;
  company: number;
  existing: number;
  seen: number;
  remembered: number;
};
export function triageGreenhouseSearchCards(
  store: Store,
  run: PullRun,
  page: GreenhousePage,
) {
  const counts: GreenhouseBatchTriage = {
    new: 0,
    title: 0,
    old: 0,
    company: 0,
    existing: 0,
    seen: 0,
    remembered: 0,
  };
  const identity = greenhouseSearchIdentity(page);
  const policy = runGreenhousePolicy(run, store.settings());
  const openings = [
    ...store.list("cache_opening"),
    ...store.list("custom_opening"),
  ];
  for (const card of page.cards) {
    const id = `${run.id}:${card.board}:${card.id}`;
    const existing = store.get("greenhouse_pull_candidate", id);
    const origins =
      existing?.discoveredBy ??
      run.pages
        .filter((saved) => saved.ids.includes(`${card.board}:${card.id}`))
        .map((saved) => greenhouseSearchIdentity(saved).key);
    const candidate: PullCandidate = existing ?? {
      id,
      runId: run.id,
      card,
      state: "discovered",
    };
    const disposition = !existing
      ? greenhouseCardDisposition(
          store,
          candidate,
          openings,
          Date.parse(page.at),
          policy,
        )
      : undefined;
    if (existing?.remembered) counts.remembered++;
    if (existing) counts.seen++;
    else if (disposition?.state === "existing") counts.existing++;
    else if (disposition?.state === "excluded") {
      if (greenhouseCompanyDisposition(store, candidate, policy))
        counts.company++;
      else if (
        oldPullSearchDate(
          candidate,
          Date.parse(page.at),
          policy.freshnessDays,
          policy.cardDateMarginDays ?? greenhouseCardDateMarginDays,
        )
      )
        counts.old++;
      else counts.title++;
    } else counts.new++;
    store.put("greenhouse_pull_candidate", id, {
      ...candidate,
      ...disposition,
      discoveredBy: [...new Set([...origins, identity.key])],
    });
  }
  return counts;
}
