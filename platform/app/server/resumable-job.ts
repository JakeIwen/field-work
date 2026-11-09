import { diagnosticLog } from "./diagnostic-log.js";
import type { Records } from "./records.js";
import { HttpError, Store, now } from "./storage.js";

type ResumableRunKind = "career_scan" | "opening_validation_run";
type RecoveryPolicy<K extends ResumableRunKind> = {
  eligibleStatuses: readonly string[];
  interrupt: (run: Records[K]) => void;
  before?: (run: Records[K]) => void;
  reload?: (run: Records[K]) => Records[K] | undefined;
};

export abstract class ResumableJob<K extends ResumableRunKind> {
  protected controller: AbortController | null = null;
  protected running: Promise<unknown> | null = null;
  protected activeId: string | null = null;

  constructor(
    private jobStore: Store,
    private jobNotify: () => void,
    private runKind: K,
  ) {}

  protected saveRun(run: Records[K], id = run.id): Records[K] {
    const saved: Records[K] = { ...run, updatedAt: now() };
    this.jobStore.put(this.runKind, id, saved);
    this.jobStore.autoExport();
    this.jobNotify();
    return saved;
  }

  protected recoverInterruptedRuns(policy: RecoveryPolicy<K>): void {
    // Load each payload by its persisted key, never by a potentially corrupt id.
    const rows = this.jobStore.db
      .prepare("SELECT id FROM records WHERE kind=? ORDER BY rowid")
      .all(this.runKind);
    for (const row of rows) {
      const storageId = row.id;
      if (typeof storageId !== "string") continue;
      const snapshot = this.jobStore.get(this.runKind, storageId);
      if (!snapshot) {
        diagnosticLog(
          "warn",
          "resumable-job",
          `Skipping missing ${this.runKind} ${storageId} during recovery`,
        );
        continue;
      }
      if (this.runKind === "career_scan" && storageId !== snapshot.id) {
        this.recoverMismatchedCareerRun(
          snapshot,
          storageId,
          policy.eligibleStatuses,
        );
        continue;
      }
      policy.before?.(snapshot);
      const run = policy.reload ? policy.reload(snapshot) : snapshot;
      if (!run) {
        diagnosticLog(
          "warn",
          "resumable-job",
          `Skipping missing ${this.runKind} ${snapshot.id} during recovery`,
        );
        continue;
      }
      if (policy.eligibleStatuses.includes(run.status)) policy.interrupt(run);
    }
  }

  private recoverMismatchedCareerRun(
    snapshot: Records[K],
    storageId: string,
    eligibleStatuses: readonly string[],
  ): void {
    if (
      !eligibleStatuses.includes(snapshot.status) &&
      snapshot.status !== "publishing"
    ) {
      diagnosticLog(
        "warn",
        "resumable-job",
        `Skipping mismatched ${this.runKind} ${snapshot.id} stored as ${storageId} during recovery`,
      );
      return;
    }
    const current = this.jobStore.get(this.runKind, storageId);
    if (!current) {
      diagnosticLog(
        "warn",
        "resumable-job",
        `Skipping missing ${this.runKind} ${storageId} during recovery`,
      );
      return;
    }
    if (
      current.id !== snapshot.id ||
      current.status !== snapshot.status ||
      this.jobStore.isDeleted(this.runKind, storageId)
    ) {
      diagnosticLog(
        "warn",
        "resumable-job",
        `Skipping changed or deleted ${this.runKind} ${storageId} during recovery`,
      );
      return;
    }
    const publishing = current.status === "publishing";
    const recovered: Records[K] = {
      ...current,
      status: "failed",
      error:
        "Server restarted, but this scan's stored identity does not match its storage key. Recovery was skipped; start a new scan." +
        (publishing ? " Publication recovery was not attempted." : ""),
    };
    try {
      this.jobStore.put(this.runKind, storageId, recovered);
    } catch (error) {
      if (error instanceof HttpError && error.status === 410) {
        diagnosticLog(
          "warn",
          "resumable-job",
          `Skipping deleted ${this.runKind} ${storageId} during recovery`,
        );
        return;
      }
      throw error;
    }
  }

  protected launchRun(
    id: string,
    worker: (signal: AbortSignal) => Promise<unknown>,
    onFailure: (error: Error, signal: AbortSignal) => unknown,
    afterLaunch?: () => void,
    afterSettled?: () => void,
  ): void {
    this.activeId = id;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const work = worker(signal);
    this.running = work
      .catch((error: Error) => onFailure(error, signal))
      .finally(() => {
        this.activeId = null;
        this.controller = null;
        this.running = null;
        afterSettled?.();
      })
      .catch((error) => {
        diagnosticLog(
          "error",
          "resumable-job",
          `Could not finish ${this.runKind} ${id}:`,
          {},
          error,
        );
      });
    afterLaunch?.();
  }

  get active(): boolean {
    return !!this.running;
  }

  async close(): Promise<void> {
    this.controller?.abort();
    await this.running;
  }
}
