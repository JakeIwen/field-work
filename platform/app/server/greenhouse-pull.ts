import { recordedAgentLabel } from "../shared/codex-models.js";
import { tunable, tunableMs } from "./tunables.js";
import { diagnosticLog } from "./diagnostic-log.js";
import { GreenhousePullLoop } from "./greenhouse-pull-loop.js";
import {
  applyRememberedReview,
  saveCandidateDisposition,
} from "./opening-pull/review-memory-pipeline.js";
import { backfillReviewMemory } from "./opening-pull/review-memory-backfill.js";
import type { CareersFetch } from "./careers/http.js";
import { publishGreenhouseReview } from "./greenhouse-pull-publication.js";
import { recordGreenhouseParallelReviews } from "./greenhouse-review-settings.js";
import * as reviewCooldown from "./greenhouse-review-cooldown.js";
import { pullProvider } from "./opening-pull/contract.js";
import {
  greenhouseSaveActivity,
  greenhouseOutcomeActivity,
  retainGreenhouseActivity,
  recordGreenhouseReviewStart,
  greenhouseReviewFailureActivity,
  greenhouseInterruptionFailureActivity,
  observeGreenhouseReviewActivity,
} from "./greenhouse-pull-activity.js";
import {
  finishingGreenhouseWork,
  greenhousePullHasWork,
  finishGreenhousePull,
  stopGreenhousePull,
} from "./greenhouse-pull-stop.js";
import { runGreenhousePolicy } from "./opening-pull/policy.js";
import { newGreenhousePullRun } from "./greenhouse-pull-start.js";
import { summarizePull } from "./opening-pull/state.js";
import { pullDateDisposition } from "./opening-pull/dates.js";
import { existingGreenhouseOpening } from "./opening-pull/identity.js";
export {
  existingGreenhouseOpening,
  greenhousePublicId,
} from "./opening-pull/identity.js";
import {
  greenhouseSearchPending,
  nextGreenhouseReviewCursor,
} from "./greenhouse-query-plan.js";
import { searchGreenhousePullPage } from "./greenhouse-pull-search.js";
import { greenhouseSearchProgress } from "./greenhouse-pull-discovery.js";
import {
  greenhousePullFailure,
  greenhouseSearchRateError,
} from "./greenhouse-pull-failures.js";
import {
  greenhousePacingRate,
  recordGreenhousePacingIncrease,
} from "./greenhouse-pacing.js";
import {
  chooseGreenhouseWork,
  greenhouseReviews,
  retryGreenhouseReviews,
  conflictingGreenhouseReview,
  failedGreenhouseReview,
} from "./greenhouse-pull-scheduling.js";
import {
  legacyMultiProviderPull,
  greenhouseReviewFinishing,
  greenhouseReviewPublicationAllowed,
  type PullRun,
  type PullCandidate,
} from "./greenhouse-pull-records.js";
export type { PullRun, PullCandidate } from "./greenhouse-pull-records.js";
export {
  greenhouseSkipTool,
  greenhouseReviewInstructions,
  stageGreenhouseDecision,
} from "./greenhouse-research.js";
import { isTaskBusy, isTaskWaiting } from "../shared/types.js";
import type { Task } from "../shared/task-records.js";
import { randomUUID } from "node:crypto";
import { Store, HttpError } from "./storage.js";
import { pullPostingExclusion } from "./opening-pull/screen.js";
import {
  greenhouseCardDisposition,
  greenhouseCompanyDisposition,
} from "./opening-pull/card-triage.js";
import {
  LiveGreenhouseSource,
  GreenhouseLimit,
  GreenhouseSearchCancelled,
  type GreenhouseSource,
  type GreenhousePosting,
} from "./greenhouse-source.js";
import {
  greenhousePullFinished,
  greenhousePullBlocksNewRun,
  type GreenhousePullSummary,
} from "../shared/greenhouse-pull.js";

type StepAction =
  | { kind: "close" }
  | { kind: "greenhouse-search"; run: PullRun; page: number }
  | { kind: "candidate"; run: PullRun; candidate: PullCandidate }
  | undefined;
type ReviewAction =
  | { kind: "start"; task: Task }
  | { kind: "publish"; task: Task }
  | { kind: "done" };
type Dependencies = reviewCooldown.ReviewServices & {
  source?: GreenhouseSource;
  interruptTask?: (id: string) => Promise<unknown>;
  clock?: () => number;
  autoStart?: boolean;
  /** Tests inject the form reader; production uses the paced public fetch. */
  formCheckRead?: CareersFetch;
};
const runKind = "greenhouse_pull_run",
  candidateKind = "greenhouse_pull_candidate";

export class GreenhousePullManager {
  private source: GreenhouseSource;
  private loop: GreenhousePullLoop;
  private pending?: Promise<boolean | void>;
  private interrupts = new Set<Promise<void>>();
  private stopped = false;
  private clock: () => number;
  constructor(
    private store: Store,
    private deps: Dependencies,
  ) {
    this.source =
      deps.source ??
      new LiveGreenhouseSource(
        {
          read: () => store.get("greenhouse_browser", "owned-tab")?.tabId ?? "",
          write: (tabId) => {
            if (store.get("greenhouse_browser", "owned-tab")?.tabId !== tabId)
              store.put("greenhouse_browser", "owned-tab", { tabId });
          },
        },
        undefined,
        { settings: () => store.settings() },
      );
    this.clock = deps.clock ?? Date.now;
    backfillReviewMemory(store);
    this.deps = reviewCooldown.withReviewCooldown(store, deps, this.clock);
    for (const r of store.list(runKind) as PullRun[])
      if (
        !legacyMultiProviderPull(r) &&
        ["running", "cooldown"].includes(r.status)
      ) {
        this.save({
          ...r,
          status: "paused",
          phase:
            "Service restarted. Resume to continue the saved page and review.",
        });
        this.cancelSearch(r.searchNonce);
      }
    this.loop = new GreenhousePullLoop(
      () => this.pending ?? this.tick(),
      deps.autoStart !== false,
      () => tunableMs(store, "greenhouse.loopIntervalMs"),
      () => tunable(store, "greenhouse.burstSteps"),
    );
  }
  wake() {
    this.loop.wake();
  }
  private save(r: PullRun) {
    r = greenhouseSaveActivity(this.store, r, this.clock());
    if (greenhousePullFinished(r.status)) r.finalPacingRate = r.pacingRate;
    r.updatedAt = new Date(this.clock()).toISOString();
    this.store.put(runKind, r.id, r);
    this.store.autoExport();
    this.deps.notify();
    return r;
  }
  private candidates(id: string, sources = false): PullCandidate[] {
    // State refreshes during streamed Codex output must not hydrate every full posting/history.
    const rows = this.store.db
      .prepare(
        `SELECT ${sources ? "json" : "json_remove(json, '$.posting')"} AS json FROM records WHERE kind=? AND id GLOB ? ORDER BY rowid`,
      )
      .all(candidateKind, `${id}:*`) as { json: string }[];
    return rows.map((row) => JSON.parse(row.json));
  }
  latest(): PullRun | undefined {
    const row = this.store.db
      .prepare(
        "SELECT json FROM records WHERE kind=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(runKind) as { json: string } | undefined;
    return row ? JSON.parse(row.json) : undefined;
  }
  state(): GreenhousePullSummary | null {
    const r = this.latest();
    if (!r) return null;
    return summarizePull(this.store, r, this.candidates(r.id));
  }
  hasWork() {
    return greenhousePullHasWork(this.store);
  }
  start(target: unknown = 10, clientRequestId: unknown = "") {
    if (!Number.isInteger(target) || Number(target) < 1 || Number(target) > 100)
      throw new HttpError(400, "Choose 1–100 new openings");
    if (typeof clientRequestId !== "string" || clientRequestId.length > 100)
      throw new HttpError(400, "Invalid request identity");
    const previous = this.store
      .list(runKind)
      .find((r) => r.clientRequestId && r.clientRequestId === clientRequestId);
    if (previous) return previous;
    const active = this.latest();
    if (active && greenhousePullBlocksNewRun(active.status)) return active;
    const r = newGreenhousePullRun(
      this.store,
      Number(target),
      clientRequestId,
      active,
      this.clock(),
    );
    this.save(r);
    return r;
  }
  action(id: string, action: unknown, interruptReviews: unknown = false) {
    if (typeof interruptReviews !== "boolean")
      throw new HttpError(400, "interruptReviews must be a boolean");
    const r = this.store.get(runKind, id) as PullRun;
    if (!r || (this.latest()?.id !== id && !greenhouseReviewFinishing(r)))
      throw new HttpError(404, "Current or finishing posting pull not found");
    if (greenhousePullFinished(r.status) && !greenhouseReviewFinishing(r))
      return r;
    if (
      (action === "pause" || action === "stop" || action === "stop_reviews") &&
      this.latest()?.id === id
    )
      this.cancelSearch(r.searchNonce);
    if (action === "pause")
      return this.save({
        ...r,
        status: "paused",
        phase:
          "Paused. Any current review can finish, but no more openings will be added until resumed.",
      });
    if (action === "stop" || action === "stop_reviews") {
      const interrupt = action === "stop_reviews" || interruptReviews;
      const stopped = this.save(
        stopGreenhousePull(r, this.candidates(r.id), interrupt, this.clock()),
      );
      if (interrupt)
        for (const candidate of this.candidates(r.id))
          if (candidate.state === "reviewing" && candidate.taskId)
            this.interruptReview(candidate.taskId, r.id);
      return stopped;
    }
    if (action !== "resume")
      throw new HttpError(400, "Choose pause, resume, stop or stop_reviews");
    if (legacyMultiProviderPull(r))
      throw new HttpError(
        409,
        "Ashby and Lever pulls are no longer supported. Stop this saved pull and start a new Greenhouse pull.",
      );
    if (r.retryAt && Date.parse(r.retryAt) > this.clock())
      return this.save({
        ...r,
        status: "cooldown",
        phase: "Waiting for source cooldown",
      });
    retryGreenhouseReviews(this.store, this.candidates(r.id));
    return this.save({
      ...r,
      status: r.finishReason && r.finishReviews ? "finishing" : "running",
      error: undefined,
      retryAt: undefined,
      phase: "Resuming saved progress",
      searchRetry: r.status === "failed" ? undefined : r.searchRetry,
    });
  }
  ledger(id: string) {
    const run = this.store.get(runKind, id);
    if (!run) throw new HttpError(404, "Pull not found");
    return {
      run: { ...run, activity: run.activity ?? [] },
      candidates: this.candidates(id, true),
    };
  }
  async tick() {
    if (this.stopped || this.pending || this.interrupts.size) return;
    const runId = this.latest()?.id;
    this.pending = this.step()
      .catch((error) => {
        if (error instanceof GreenhouseSearchCancelled) return;
        const r =
          runId && (this.store.get(runKind, runId) as PullRun | undefined);
        if (!r) {
          diagnosticLog(
            "warn",
            "greenhouse-pull",
            `Skipping failure update for missing Greenhouse pull ${runId}:`,
            {},
            error,
          );
          return;
        }
        if (!["running", "cooldown"].includes(r.status)) return;
        const at = this.clock();
        this.store.transaction(() => {
          const failed = greenhouseReviewFailureActivity(
            this.store,
            greenhousePullFailure(r, error, at, this.store.settings()),
            error,
            at,
          );
          if (greenhouseSearchRateError(r, error))
            Object.assign(
              failed,
              recordGreenhousePacingIncrease(this.store, failed, error, at),
            );
          this.store.put(runKind, r.id, {
            ...retainGreenhouseActivity(this.store, failed),
            updatedAt: new Date(at).toISOString(),
          });
        });
        this.store.autoExport();
        this.deps.notify();
      })
      .finally(() => {
        this.pending = undefined;
      });
    return this.pending;
  }
  private cancelSearch(nonce?: string) {
    if (!this.source.cancelSearch) return;
    const pending = this.source
      .cancelSearch(nonce)
      .catch((error) => {
        diagnosticLog(
          "error",
          "greenhouse-pull",
          "Could not stop Greenhouse search driver:",
          {},
          error,
        );
      })
      .finally(() => this.interrupts.delete(pending));
    this.interrupts.add(pending);
  }
  private interruptReview(taskId: string, runId: string) {
    const task = this.store.get("task", taskId);
    if (!this.deps.interruptTask || !task?.threadId || !isTaskBusy(task.status))
      return;
    const pending = this.deps
      .interruptTask(taskId)
      .then(() => {})
      .catch((error) => {
        const r = this.store.get(runKind, runId) as PullRun;
        if (r)
          this.save({
            ...greenhouseInterruptionFailureActivity(
              this.store,
              r,
              taskId,
              error,
              this.clock(),
            ),
            error: `Pull stopped, but the current Codex review could not be interrupted: ${String(error)}. Open Review details to inspect it.`,
          });
      })
      .finally(() => this.interrupts.delete(pending))
      .catch((error) => {
        diagnosticLog(
          "error",
          "greenhouse-pull",
          `Could not record interruption for Greenhouse pull ${runId}:`,
          {},
          error,
        );
      });
    this.interrupts.add(pending);
  }
  private active(id: string) {
    const r = this.store.get(runKind, id) as PullRun;
    return !this.stopped && r && greenhouseReviewPublicationAllowed(r)
      ? r
      : undefined;
  }
  private disposition(
    r: PullRun,
    c: PullCandidate,
    state: PullCandidate["state"],
    reason: string,
    extra: Partial<PullCandidate> = {},
  ) {
    this.store.transaction(() => {
      saveCandidateDisposition(
        this.store,
        r,
        { ...c, ...extra, state, reason },
        this.clock(),
      );
      this.store.put(runKind, r.id, {
        ...retainGreenhouseActivity(
          this.store,
          greenhouseOutcomeActivity(r, c, state, reason, this.clock()),
        ),
        currentId: undefined,
        error: undefined,
        phase: `Checked ${c.card.title}`,
        retryCandidateId: undefined,
        updatedAt: new Date(this.clock()).toISOString(),
      });
    });
    this.store.autoExport();
    this.deps.notify();
  }
  private prepareStep(): StepAction {
    let run = this.latest();
    if (!run) return;
    if (greenhousePullFinished(run.status) || legacyMultiProviderPull(run))
      return this.hasWork() ? undefined : { kind: "close" };
    if (
      run.status === "cooldown" &&
      Date.parse(run.retryAt || "") <= this.clock()
    )
      run = this.save({
        ...run,
        status: "running",
        retryAt: undefined,
        error: undefined,
        phase: "Retrying after cooldown",
      });
    if (run.status !== "running") return;
    const candidates = this.candidates(run.id);
    if (
      candidates.filter((candidate) => candidate.state === "added").length >=
      run.target
    ) {
      this.save(finishGreenhousePull(run, candidates, "target"));
      return;
    }
    run = recordGreenhouseParallelReviews(
      this.store,
      run,
      this.clock(),
      this.deps.notify,
    );
    const work = chooseGreenhouseWork(
      this.store,
      run,
      candidates,
      this.clock(),
    );
    const candidate = work.candidate
      ? this.store.get(candidateKind, work.candidate.id)
      : undefined;
    if (!candidate) {
      if (
        work.canSearch ||
        !candidates.some((candidate) =>
          ["discovered", "reviewing"].includes(candidate.state),
        )
      )
        return this.prepareSearch(run);
      const reviews = greenhouseReviews(this.store, candidates);
      const waiting = reviews.filter((review) =>
        isTaskWaiting(review.status),
      ).length;
      const phase = `${reviews.length} ${reviews.length === 1 ? "review" : "reviews"} in progress${waiting ? `; ${waiting} ${waiting === 1 ? "needs" : "need"} your input` : ""}`;
      if (run.phase !== phase) this.save({ ...run, phase });
      return;
    }
    return this.prepareCandidate(run, candidate);
  }
  private prepareSearch(run: PullRun): StepAction {
    if (!greenhouseSearchPending(run)) {
      this.save({
        ...run,
        status: "exhausted",
        phase:
          "Selected Greenhouse search pages checked. Deferred listings remain in the ledger; this is not global market coverage.",
      });
      return { kind: "close" };
    }
    run = this.save({
      ...run,
      phase: greenhouseSearchProgress(run),
      searchNonce: run.searchNonce ?? randomUUID(),
      searchTransport: undefined,
      searchTransportNote: undefined,
      pacingRate: run.pacingRate ?? greenhousePacingRate(this.store),
      initialPacingRate:
        run.initialPacingRate ??
        run.pacingRate ??
        greenhousePacingRate(this.store),
      searchInProgress: true,
      currentId: undefined,
    });
    return { kind: "greenhouse-search", run, page: run.page };
  }
  private prepareCandidate(run: PullRun, candidate: PullCandidate): StepAction {
    if (pullProvider(candidate.card) !== "greenhouse")
      throw new HttpError(
        409,
        "This saved candidate belongs to a retired pull source",
      );
    if (run.currentId !== candidate.id)
      run = this.save({
        ...run,
        currentId: candidate.id,
        reviewCursor:
          candidate.state === "discovered"
            ? nextGreenhouseReviewCursor(run, candidate)
            : run.reviewCursor,
        phase: `Checking ${candidate.card.company} · ${candidate.card.title}`,
      });
    const disposition = greenhouseCardDisposition(
      this.store,
      candidate,
      undefined,
      this.clock(),
      runGreenhousePolicy(run, this.store.settings()),
    );
    if (disposition) {
      this.disposition(
        run,
        candidate,
        disposition.state,
        disposition.reason,
        disposition,
      );
      return;
    }
    return { kind: "candidate", run, candidate };
  }
  private acceptPosting(
    run: PullRun,
    candidate: PullCandidate,
    posting: GreenhousePosting | null,
  ): GreenhousePosting | undefined {
    if (!posting) {
      this.disposition(
        run,
        candidate,
        "excluded",
        "Official posting API confirms 404/410; this advertisement is no longer available.",
      );
      return;
    }
    candidate.posting = posting;
    this.store.put(candidateKind, candidate.id, candidate);
    const duplicate = existingGreenhouseOpening(
      this.store,
      candidate.card,
      posting,
    );
    if (duplicate) {
      this.disposition(
        run,
        candidate,
        "existing",
        "Employer/internal requisition matches an existing Fieldwork opening.",
        { openingId: duplicate.id },
      );
      return;
    }
    return posting;
  }
  private screenCandidate(
    run: PullRun,
    candidate: PullCandidate,
    posting: GreenhousePosting,
  ) {
    const policy = runGreenhousePolicy(run, this.store.settings());
    const company = greenhouseCompanyDisposition(this.store, candidate, policy);
    if (company) {
      this.disposition(run, candidate, company.state, company.reason);
      return false;
    }
    const excluded = pullPostingExclusion(
      this.store,
      candidate,
      posting,
      policy,
    );
    if (excluded) {
      this.disposition(run, candidate, "excluded", excluded);
      return false;
    }
    const dateResult = pullDateDisposition(run, posting, this.clock());
    if (dateResult) {
      this.disposition(run, candidate, dateResult.state, dateResult.reason);
      return false;
    }
    if (posting.raw.isListed === false) {
      this.disposition(
        run,
        candidate,
        "excluded",
        "Official feed marks this posting unlisted.",
      );
      return false;
    }
    return !applyRememberedReview(
      this.store,
      run,
      candidate,
      this.clock(),
      this.deps.notify,
    );
  }
  private saveResearchTask(run: PullRun, candidate: PullCandidate, task: Task) {
    // Persist the task link even when paused during bundle creation; resume reuses it.
    const savedRun = this.store.get(runKind, run.id);
    if (
      !savedRun ||
      savedRun.finishReviews === false ||
      !this.store.get(candidateKind, candidate.id) ||
      !this.store.get("task", task.id)
    )
      return;
    this.store.put(candidateKind, candidate.id, {
      ...candidate,
      state: "reviewing",
      taskId: task.id,
    });
    const current = this.active(run.id);
    if (current)
      this.save({
        ...current,
        phase: `Codex reviewing ${candidate.card.company} · ${candidate.card.title}`,
        retryCandidateId: undefined,
      });
  }
  private reviewAction(
    run: PullRun,
    candidate: PullCandidate,
    taskId: string,
  ): ReviewAction {
    const task = this.store.get("task", taskId);
    if (!task) throw Error("Saved Greenhouse review is missing");
    if (["handoff", "queued"].includes(task.status) && !task.threadId)
      return { kind: "start", task };
    if (failedGreenhouseReview(task.status))
      return reviewCooldown.failedReview(
        this.store,
        run,
        candidate,
        task,
        this.clock(),
        this.deps.notify,
      );
    if (task.status !== "completed") {
      const phase = isTaskWaiting(task.status)
        ? `${recordedAgentLabel(task.model)} needs your input. Open review details to continue.`
        : `Codex reviewing ${candidate.card.company} · ${candidate.card.title}`;
      if (run.phase !== phase) this.save({ ...run, phase });
      return { kind: "done" };
    }
    if (!task.greenhouseDecision)
      throw Error(
        "Codex finished without a saved decision. Open review details and ask it to save its decision, then resume.",
      );
    if (task.greenhouseDecision.decision !== "add") {
      this.disposition(
        run,
        candidate,
        task.greenhouseDecision.decision,
        task.greenhouseDecision.reason!,
        { reviewed: true },
      );
      return { kind: "done" };
    }
    return { kind: "publish", task };
  }
  private async searchStep(
    work: Extract<StepAction, { kind: "greenhouse-search" }>,
  ) {
    await searchGreenhousePullPage(this.store, this.source, work.run, {
      active: () => {
        const run = this.active(work.run.id);
        return run?.status === "running" ? run : undefined;
      },
      save: (run) => {
        this.save(run);
      },
      notify: this.deps.notify,
      clock: this.clock,
    });
  }
  private async step() {
    if (observeGreenhouseReviewActivity(this.store, this.clock()))
      this.deps.notify();
    const stopped = finishingGreenhouseWork(
      this.store,
      this.clock(),
      this.deps.notify,
    );
    const action = stopped
      ? { kind: "candidate" as const, ...stopped }
      : this.prepareStep();
    if (!action) return;
    if (action.kind === "close") {
      await this.source.close();
      return;
    }
    if (action.kind === "greenhouse-search") {
      await this.searchStep(action);
      return;
    }
    await this.candidateStep(action).catch((error) => {
      if (!greenhouseReviewFinishing(action.run)) throw error;
      const run = this.store.get(runKind, action.run.id);
      const candidate = this.store.get(candidateKind, action.candidate.id);
      if (!run || !greenhouseReviewFinishing(run) || !candidate) return;
      if (error instanceof GreenhouseLimit) {
        this.save({
          ...greenhousePullFailure(
            run,
            error,
            this.clock(),
            this.store.settings(),
          ),
          status: "finishing",
          phase: run.phase,
        });
        return;
      }
      if (candidate.state === "reviewing" || candidate.state === "discovered")
        this.disposition(
          run,
          candidate,
          "deferred",
          `Finishing review could not publish: ${String(error)}`,
        );
    });
    return true;
  }
  private async candidateStep(
    action: Extract<StepAction, { kind: "candidate" }>,
  ) {
    let { run } = action;
    const candidate = action.candidate;
    if (greenhouseReviewFinishing(run)) {
      const prepared = this.prepareCandidate(run, candidate);
      if (prepared?.kind !== "candidate") return;
      run = prepared.run;
    }
    let posting = candidate.posting;
    if (!posting) {
      const fetched = await this.source.posting(candidate.card);
      const current = this.active(run.id);
      if (!current) return;
      run = current;
      posting = this.acceptPosting(run, candidate, fetched);
      if (!posting) return;
      if (run.retryCandidateId === candidate.id)
        run = this.save({ ...run, retryCandidateId: undefined });
    }
    if (!this.screenCandidate(run, candidate, posting)) return;
    if (!candidate.taskId) {
      const waitingFor = conflictingGreenhouseReview(
        this.store,
        candidate,
        this.candidates(run.id),
      );
      if (waitingFor) {
        this.store.put(candidateKind, candidate.id, {
          ...candidate,
          waitingFor,
        });
        return;
      }
      const task = await this.deps.createResearch(run, candidate);
      if (!task) return;
      this.saveResearchTask(run, candidate, task);
      return;
    }
    const review = this.reviewAction(run, candidate, candidate.taskId);
    if (review.kind === "start") {
      await this.deps.startTask(review.task.id);
      if (recordGreenhouseReviewStart(this.store, candidate, this.clock()))
        this.deps.notify();
      if (this.store.get(runKind, run.id)?.finishReviews === false)
        this.interruptReview(review.task.id, run.id);
      return;
    }
    if (review.kind === "publish")
      publishGreenhouseReview(
        this.store,
        run,
        candidate,
        posting,
        review.task.id,
        () => this.candidates(run.id),
        () => this.clock(),
        this.deps.notify,
        this.deps.formCheckRead,
      );
  }
  async close() {
    this.stopped = true;
    this.cancelSearch();
    await this.loop.close();
    await this.pending;
    await Promise.allSettled([...this.interrupts]);
    await this.source.close().catch(() => {});
  }
}
