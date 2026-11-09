import { now, type Store } from "../storage.js";
import { saveReviewMemory } from "./review-memory.js";

// Versions 3 and 4 memorized nothing: 3 counted every initial prompt as user
// steering, and both required task.completedAt, which tasks never record.
const reviewMemoryMigrationVersion = 5;

/** Legacy bundles have empty sourceHashes and no captured policy template: fail closed. */
export function backfillReviewMemory(store: Store) {
  return store.transaction(() => {
    if (
      store.db
        .prepare("SELECT 1 FROM migrations WHERE version=?")
        .get(reviewMemoryMigrationVersion)
    )
      return { backfilled: 0, skipped: 0, alreadyApplied: true };
    let backfilled = 0;
    let skipped = 0;
    for (const candidate of store.list("greenhouse_pull_candidate")) {
      if (
        !candidate.reviewed ||
        candidate.remembered ||
        !["excluded", "deferred"].includes(candidate.state) ||
        !candidate.taskId
      )
        continue;
      const run = store.get("greenhouse_pull_run", candidate.runId);
      const task = store.get("task", candidate.taskId);
      // Tasks keep no completion time; their last update is the decision's.
      const decidedAt = task?.completedAt ?? task?.updatedAt;
      if (
        run &&
        task &&
        decidedAt &&
        task.greenhouseDecision?.decision === candidate.state &&
        saveReviewMemory(store, run, candidate, task, decidedAt)
      )
        backfilled++;
      else skipped++;
    }
    store.db
      .prepare("INSERT INTO migrations(version,applied_at) VALUES(?,?)")
      .run(reviewMemoryMigrationVersion, now());
    store.journal(
      "greenhouse_review_memory_backfill",
      `Remembered ${backfilled} earlier reviews; ${skipped} lacked complete captured inputs`,
      undefined,
      { backfilled, skipped },
    );
    store.autoExport();
    return { backfilled, skipped, alreadyApplied: false };
  });
}
