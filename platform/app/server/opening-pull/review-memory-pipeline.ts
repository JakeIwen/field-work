import type { PullCandidate, PullRun } from "../greenhouse-pull-records.js";
import type { Store } from "../storage.js";
import {
  appendGreenhouseActivity,
  retainGreenhouseActivity,
} from "../greenhouse-pull-activity.js";
import { greenhouseSearchIdentity } from "../../shared/greenhouse-search.js";
import {
  rememberedReview,
  rememberedReviewLabel,
  saveReviewMemory,
} from "./review-memory.js";

export function saveCandidateDisposition(
  store: Store,
  run: PullRun,
  candidate: PullCandidate,
  at: number,
) {
  store.put("greenhouse_pull_candidate", candidate.id, candidate);
  const task =
    candidate.reviewed && candidate.taskId
      ? store.get("task", candidate.taskId)
      : undefined;
  if (task)
    saveReviewMemory(
      store,
      run,
      candidate,
      task,
      task.completedAt ?? new Date(at).toISOString(),
    );
}

export function applyRememberedReview(
  store: Store,
  run: PullRun,
  candidate: PullCandidate,
  at: number,
  notify: () => void,
) {
  if (candidate.taskId) return false;
  const memory = rememberedReview(store, run, candidate, at);
  if (!memory) return false;
  const label = rememberedReviewLabel(memory);
  store.transaction(() => {
    store.put("greenhouse_pull_candidate", candidate.id, {
      ...candidate,
      state: memory.outcome,
      reason: `${label[0].toUpperCase()}${label.slice(1)}: ${memory.reason}`,
      taskId: memory.taskId,
      remembered: {
        memoryId: memory.id,
        decidedAt: memory.decidedAt,
        outcome: memory.outcome,
      },
    });
    const activity = updateRememberedPageCounts(store, run);
    const updated = appendGreenhouseActivity(
      { ...run, activity },
      {
        lane: "review",
        level: "info",
        remembered: true,
        candidateId: candidate.id,
        taskId: memory.taskId,
        text: `Skipped ${candidate.card.company} · ${candidate.card.title}: ${label}`,
      },
      at,
    );
    store.put("greenhouse_pull_run", run.id, {
      ...retainGreenhouseActivity(store, updated),
      currentId: undefined,
      retryCandidateId: undefined,
      error: undefined,
      phase: `Checked ${candidate.card.title}`,
      updatedAt: new Date(at).toISOString(),
    });
  });
  store.autoExport();
  notify();
  return true;
}

function updateRememberedPageCounts(store: Store, run: PullRun) {
  const rows = store.db
    .prepare(
      "SELECT json_extract(json, '$.card.board') AS board, json_extract(json, '$.card.id') AS postingId FROM records WHERE kind='greenhouse_pull_candidate' AND json_extract(json, '$.runId')=? AND json_extract(json, '$.remembered') IS NOT NULL",
    )
    .all(run.id);
  const remembered = new Set(
    rows.map((row) => `${row.board}:${row.postingId}`),
  );
  const counts = new Map(
    run.pages.map((page) => [
      `${greenhouseSearchIdentity(page).key}:${page.page}`,
      page.ids.filter((id) => remembered.has(id)).length,
    ]),
  );
  return run.activity?.map((entry) =>
    entry.triagePage
      ? {
          ...entry,
          text: entry.text.replace(
            /\d+ reviewed in earlier pulls/,
            `${counts.get(entry.triagePage) ?? 0} reviewed in earlier pulls`,
          ),
        }
      : entry,
  );
}
