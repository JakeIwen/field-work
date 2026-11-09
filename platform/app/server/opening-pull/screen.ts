import type { Store } from "../storage.js";
import type { PullCard, PullPosting } from "./contract.js";
import { pullPostingTitle } from "./contract.js";
import { excludedTechnology } from "../fit-criteria.js";
import type { PullCandidate } from "../greenhouse-pull-records.js";
import { pullTravelExclusion } from "./travel.js";
import type { CapturedGreenhousePolicy } from "../../shared/greenhouse-policy.js";
import { greenhousePolicyFitCriteria, runGreenhousePolicy } from "./policy.js";

export function pullTechnologyExclusion(
  store: Store,
  card: PullCard,
  posting: PullPosting,
  policy?: CapturedGreenhousePolicy,
) {
  const criteria = policy
    ? greenhousePolicyFitCriteria(policy)
    : store.settings().fitCriteria;
  return excludedTechnology(
    `${card.title}\n${pullPostingTitle(posting)}\n${posting.text}`,
    criteria,
  );
}

export function pullPostingExclusion(
  store: Store,
  candidate: PullCandidate,
  posting: PullPosting,
  policy = runGreenhousePolicy(
    store.get("greenhouse_pull_run", candidate.runId),
    store.settings(),
  ),
): string | undefined {
  const technology = pullTechnologyExclusion(
    store,
    candidate.card,
    posting,
    policy,
  );
  if (technology)
    return `Posting mentions ${technology}, which is excluded by your saved technology preferences.`;
  const task = candidate.taskId
    ? store.get("task", candidate.taskId)
    : undefined;
  // A queued task is already linked as “reviewing”, but its agent has not started.
  if (
    (!candidate.taskId && candidate.state === "discovered") ||
    (task && !task.threadId && ["handoff", "queued"].includes(task.status))
  )
    return pullTravelExclusion(posting.text, policy.travelCapPercent);
}
