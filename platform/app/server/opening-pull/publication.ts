import type { Task } from "../../shared/task-records.js";
import { HttpError, type Store } from "../storage.js";
import {
  greenhouseReviewPublicationAllowed,
  greenhouseReviewFinishing,
} from "../greenhouse-pull-records.js";
import { greenhousePolicyFitCriteria, runGreenhousePolicy } from "./policy.js";
import { pullProvider } from "./contract.js";

export function publicationPullCandidate(store: Store, task: Task) {
  if (!task.greenhousePull) return;
  const run = store.get("greenhouse_pull_run", task.greenhousePull.runId);
  const candidate = store.get(
    "greenhouse_pull_candidate",
    task.greenhousePull.candidateId,
  );
  if (
    !run ||
    !greenhouseReviewPublicationAllowed(run) ||
    !candidate ||
    candidate.taskId !== task.id ||
    candidate.state !== "reviewing" ||
    task.status !== "completed" ||
    task.greenhouseDecision?.decision !== "add"
  )
    throw new HttpError(409, "Pull publication is no longer current");
  const receipts = store.db
    .prepare(
      "SELECT COUNT(*) AS count FROM records WHERE kind='greenhouse_pull_candidate' AND id GLOB ? AND json_extract(json, '$.state')='added'",
    )
    .get(`${run.id}:*`) as { count: number };
  if (receipts.count >= run.target && !greenhouseReviewFinishing(run))
    throw new HttpError(409, "Pull target already reached");
  if (pullProvider(candidate.card) !== "greenhouse")
    throw new HttpError(
      409,
      "Ashby and Lever pulls are no longer supported; saved evidence is retained",
    );
  return candidate;
}

/** Direct research keeps its live preferences; pull publication uses its run’s inputs. */
export function researchPublicationFitCriteria(store: Store, task: Task) {
  const settings = store.settings();
  if (!task.greenhousePull) return settings.fitCriteria;
  const run = store.get("greenhouse_pull_run", task.greenhousePull.runId);
  if (!run) throw new HttpError(409, "Pull publication is no longer current");
  return greenhousePolicyFitCriteria(runGreenhousePolicy(run, settings));
}
