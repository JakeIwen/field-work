import {
  answersPreparationStaleReasons,
  currentOpeningAutofill,
} from "./autofill/validity.js";
import { diagnosticLog } from "./diagnostic-log.js";
import { parallelPreparations } from "./preparation-settings.js";
import { hasUnresolvedOverflowTurn } from "./overflow-recovery-ownership.js";
import {
  recoverDocumentOverflow,
  type OverflowFollowup,
} from "./preparation-overflow.js";
import { withReadCache } from "./storage-read-cache.js";
import { documentWritingWarning } from "./document-writing-status.js";
import { isTaskBusy } from "../shared/types.js";
import { openingErrorMessage } from "../shared/opening-error.js";
import { randomUUID } from "node:crypto";
import { Store, HttpError, now } from "./storage.js";
import { startOpeningApplication } from "./opening-workflow.js";
import { supportsApplicationAutofill } from "./application-autofill-providers.js";
import {
  applicationDocumentKinds,
  preparationDocumentKinds,
  type ApplicationDocumentKind,
  type ApplicationPreparation,
  type FullApplicationPreparation,
  type PreparationScope,
} from "../shared/application-preparation.js";
import type { AutofillRecord } from "../shared/greenhouse-autofill.js";
import type { Task } from "../shared/task-records.js";
import {
  documentOpeningHash,
  preparationDocument,
  reusableDocuments,
  scriptDocumentKinds,
} from "./preparation-documents.js";

type Dependencies = {
  followUpTask?: OverflowFollowup;
  generateScript: (
    openingId: string,
    documentIds: string[],
    preparationId?: string,
  ) => Promise<
    Pick<AutofillRecord, "id" | "documentPostingHash" | "documentSlots">
  >;
  createDocuments: (
    run: ApplicationPreparation,
    preset: string,
  ) => Promise<any>;
  startTask: (id: string) => Promise<Pick<Task, "id"> | undefined>;
  startAnswers: (
    record: AutofillRecord,
  ) => Promise<Pick<Task, "id"> | null | undefined>;
  changed: () => void;
};
type PreparationTask = Pick<Task, "status" | "error">;
const activeTask = (t: PreparationTask | null | undefined) =>
  t && isTaskBusy(t.status);
const failedTask = (t: PreparationTask | null | undefined) =>
  t &&
  ["failed", "interrupted", "unavailable", "disconnected"].includes(t.status);

/** Progress wording for the kinds a step covers. */
const kindsLabel = (kinds: readonly ApplicationDocumentKind[]) =>
  kinds.length > 1
    ? "resume and cover letter"
    : kinds[0] === "cover-letter"
      ? "cover letter"
      : "resume";

export class ApplicationPreparationManager {
  private timer?: ReturnType<typeof setTimeout>;
  private ticking = false;
  private closed = false;
  constructor(
    private store: Store,
    private deps: Dependencies,
  ) {
    for (const run of store.list("application_preparation"))
      if (["queued", "running", "waiting"].includes(run.status))
        store.put("application_preparation", run.id, {
          ...run,
          status: "paused",
          message:
            "Fieldwork restarted. Retry preparation to continue from saved work.",
          updatedAt: now(),
        });
  }
  latest(openingId: string): ApplicationPreparation | undefined {
    const run = this.store
      .list("application_preparation")
      .filter((r) => r.openingId === openingId)
      .at(-1);
    return run ? withReadCache(this.store, () => this.project(run)) : undefined;
  }
  private project(run: ApplicationPreparation): ApplicationPreparation {
    const openingId = run.openingId;
    const staleReasons: string[] = [];
    const opening = this.store.opening(openingId);
    if (!opening || documentOpeningHash(opening) !== run.openingHash)
      staleReasons.push("Opening details changed.");
    for (const id of run.documentIds) {
      try {
        const { doc } = preparationDocument(this.store, openingId, id);
        const warning = documentWritingWarning(this.store, doc);
        if (warning) staleReasons.push(warning);
      } catch (error) {
        staleReasons.push(
          error instanceof HttpError
            ? error.message
            : "A saved PDF is missing or could not be checked.",
        );
      }
    }
    if (run.scope === "answers" && run.status === "ready")
      staleReasons.push(...answersPreparationStaleReasons(this.store, run));
    return {
      ...run,
      stale: staleReasons.length > 0,
      staleReasons: [...new Set(staleReasons)],
    };
  }

  /** Stored latest run for the Opening, without `project()`'s document checks and writing warnings. */
  latestRecord(openingId: string): ApplicationPreparation | undefined {
    return this.store.latestPreparationForOpening(openingId);
  }

  active() {
    return (
      this.ticking ||
      this.store
        .list("application_preparation")
        .some((r) => ["queued", "running", "waiting"].includes(r.status))
    );
  }
  state() {
    return withReadCache(this.store, () => {
      const latest = new Map<string, ApplicationPreparation>();
      for (const run of this.store.list("application_preparation"))
        latest.set(run.openingId, run);
      return [...latest.values()].map((run) => this.project(run));
    });
  }
  start(
    openingId: string,
    documentKind?: ApplicationDocumentKind,
    scope: PreparationScope = "full",
  ) {
    if (scope !== "full" && scope !== "answers")
      throw new HttpError(400, "Choose full or answers preparation scope.");
    if (scope === "answers" && documentKind !== undefined)
      throw new HttpError(
        400,
        "Answers-only preparation cannot regenerate a document.",
      );
    if (
      documentKind !== undefined &&
      !applicationDocumentKinds.includes(documentKind)
    )
      throw new HttpError(400, "Choose resume or cover-letter to regenerate.");
    const opening = this.store.opening(openingId);
    if (!opening) throw new HttpError(404, "Opening not found");
    if (
      documentKind === "cover-letter" &&
      supportsApplicationAutofill(opening.url) &&
      !scriptDocumentKinds(
        currentOpeningAutofill(this.store, opening) ?? {},
      ).includes("cover-letter")
    )
      throw new HttpError(
        409,
        "This application form has no cover-letter upload slot, so no cover letter is generated.",
      );
    const existing = this.latest(openingId);
    if (existing && ["queued", "running", "waiting"].includes(existing.status))
      return existing;
    const supportedForm = supportsApplicationAutofill(opening.url);
    if (scope === "answers" && !supportedForm)
      throw new HttpError(
        409,
        "Answers-only preparation requires a supported Greenhouse application form.",
      );
    const replaceDocumentIds =
      scope === "answers"
        ? undefined
        : documentKind
          ? this.store
              .list("generated_document")
              .filter(
                (d) => d.openingId === openingId && d.kind === documentKind,
              )
              .map((d) => d.id)
          : existing && ["failed", "paused"].includes(existing.status)
            ? existing.replaceDocumentIds
            : undefined;
    const createdAt = now();
    const run: ApplicationPreparation = {
      id: randomUUID(),
      openingId,
      ...(scope === "answers"
        ? { scope }
        : { applicationId: startOpeningApplication(this.store, openingId).id }),
      status: "queued",
      phase: "queued",
      message: "Queued for preparation.",
      createdAt,
      updatedAt: createdAt,
      phaseHistory: [{ phase: "queued", at: createdAt }],
      openingHash: documentOpeningHash(opening),
      documentIds: [],
      ...(replaceDocumentIds ? { replaceDocumentIds } : {}),
      taskIds: [],
      supportedForm,
    };
    this.store.put("application_preparation", run.id, run);
    this.store.autoExport();
    this.deps.changed();
    this.schedule(0);
    return run;
  }
  private update(
    run: ApplicationPreparation,
    patch: Partial<Omit<ApplicationPreparation, "scope" | "applicationId">>,
  ) {
    const current = this.current(run);
    if (!current) return;
    const next = { ...current, ...patch };
    if (JSON.stringify(current) === JSON.stringify(next)) return current;
    next.updatedAt = now();
    // Appended (never rewritten) so the timeline keeps every phase, including re-entries after a restart.
    if (next.phase !== current.phase)
      next.phaseHistory = [
        ...(current.phaseHistory ?? []),
        { phase: next.phase, at: next.updatedAt },
      ];
    this.store.put("application_preparation", current.id, next);
    this.store.autoExport();
    this.deps.changed();
    return next;
  }
  // Awaited work can finish after deletion or another lifecycle transition.
  // Never recreate a missing run or overwrite its newer phase/status.
  private current(run: ApplicationPreparation) {
    const current = this.store.get("application_preparation", run.id);
    return current?.phase === run.phase && current.status === run.status
      ? current
      : undefined;
  }
  wake() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.schedule(0);
  }
  private schedule(ms = 1000) {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().catch((error) => {
        // Even failure persistence can fail (for example an unavailable Store).
        // Keep the diagnostic without an unhandled rejection killing the worker.
        diagnosticLog(
          "error",
          "application-preparation",
          "Application preparation tick failed:",
          {},
          error,
        );
      });
    }, ms);
    this.timer.unref?.();
  }
  async tick() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      // Revisit waiting tasks, but allow other queued openings to advance.
      for (const pending of this.store
        .list("application_preparation")
        .filter((r) => r.status === "waiting")) {
        const id =
          pending.phase === "documents"
            ? pending.documentTaskId
            : pending.answerTaskId;
        const task = id ? this.store.taskSummaries(id)[0] : undefined;
        if (
          task &&
          !["waiting for input", "waiting for approval"].includes(task.status)
        )
          this.update(pending, { status: "running" });
      }
      const pending = this.store
        .list("application_preparation")
        .filter((r) => ["queued", "running"].includes(r.status));
      const running = pending.filter((r) => r.status === "running").length;
      const slots = Math.max(0, parallelPreparations(this.store) - running);
      const admitted = new Set(
        pending.filter((r) => r.status === "queued").slice(0, slots),
      );
      // A lower limit only holds queued runs; admitted work must keep progressing.
      const runs = pending.filter(
        (r) => r.status === "running" || admitted.has(r),
      );
      // Start each stage serially to preserve the adapter's launch guard. Agent
      // turns and PDF renders continue in the background for all admitted runs.
      for (const run of runs) {
        try {
          await this.advance(run);
        } catch (e) {
          if (!this.current(run)) continue;
          this.update(run, {
            status: "failed",
            error: openingErrorMessage(
              this.store.opening(run.openingId) ?? { id: run.openingId },
              e,
            ),
            message:
              "Preparation stopped. Completed documents and scripts are preserved.",
          });
        }
      }
    } finally {
      this.ticking = false;
      if (
        this.store
          .list("application_preparation")
          .some((r) => ["queued", "running", "waiting"].includes(r.status))
      )
        this.schedule();
    }
  }
  private taskState(run: ApplicationPreparation, id: string, label: string) {
    const t = this.store.taskSummaries(id)[0];
    if (!t) throw new HttpError(409, `${label} task is missing.`);
    if (t.status === "handoff" || (t.status === "queued" && !t.threadId))
      return { task: t, start: true, wait: true };
    if (["waiting for input", "waiting for approval"].includes(t.status)) {
      this.update(run, {
        status: "waiting",
        message: `${label} needs your input. Open task details to respond.`,
      });
      return { task: t, wait: true };
    }
    if (failedTask(t))
      throw new HttpError(
        409,
        `${label}: ${t.error || t.status}. Open task details to recover it, then retry preparation.`,
      );
    return { task: t, wait: activeTask(t) };
  }
  /** An active task is adopted only when it produces a kind this run still lacks. */
  private reusableDocumentTask(
    run: ApplicationPreparation,
    missing: readonly ApplicationDocumentKind[],
  ) {
    const covers: Record<string, ApplicationDocumentKind[]> = {
      // A combined task always renders the resume, so it covers a missing resume too.
      "posting-application": [...applicationDocumentKinds],
      "posting-resume": ["resume"],
      "posting-cover-letter": ["cover-letter"],
    };
    return this.store
      .taskSummaries()
      .filter(
        (task) =>
          task.context?.openingId === run.openingId &&
          !task.review &&
          [
            "posting-application",
            "posting-resume",
            "posting-cover-letter",
          ].includes(task.preset) &&
          covers[task.preset].some((kind) => missing.includes(kind)) &&
          (activeTask(task) ||
            task.documentResult?.status === "rendering" ||
            task.status === "disconnected") &&
          !hasUnresolvedOverflowTurn(task),
      )
      .at(-1);
  }

  private async advance(run: ApplicationPreparation) {
    if (!this.current(run)) return;
    const opening = this.store.opening(run.openingId);
    if (!opening || documentOpeningHash(opening) !== run.openingHash)
      throw new HttpError(
        409,
        "The Opening changed. Retry preparation with its current details.",
      );
    if (run.phase === "queued") {
      this.update(run, {
        status: "running",
        phase: run.supportedForm ? "form" : "documents",
        message: run.supportedForm
          ? "Reading the current application form…"
          : "Preparing tailored documents; this site does not support console autofill yet.",
      });
      return;
    }
    if (run.phase === "form") {
      const script = await this.deps.generateScript(run.openingId, [], run.id);
      this.update(run, {
        scriptId: script.id,
        postingHash: script.documentPostingHash,
        documentKinds: scriptDocumentKinds(script),
        phase: run.scope === "answers" ? "answers" : "documents",
        message:
          run.scope === "answers"
            ? "Preparing the application answers…"
            : scriptDocumentKinds(script).length > 1
              ? "Checking saved resume and cover letter…"
              : "Checking the saved resume…",
      });
      return;
    }
    if (run.phase === "documents" && run.scope !== "answers")
      return this.advanceDocuments(run);
    if (run.phase === "answers") return this.advanceAnswers(run);
    if (run.phase === "packaging") return this.advancePackaging(run);
  }
  private async advanceDocuments(run: FullApplicationPreparation) {
    if (await this.waitForDocumentTask(run)) return;
    const docs = reusableDocuments(
      this.store,
      run.openingId,
      run.postingHash,
      run.documentTaskId,
    ).filter((doc) => !run.replaceDocumentIds?.includes(doc.id));
    // Legacy PDFs of a kind the form has no slot for are neither attached nor linked.
    const expected = preparationDocumentKinds(run);
    const wanted = docs.filter((doc) => expected.includes(doc.kind));
    const missing = expected.filter(
      (kind) => !wanted.some((d) => d.kind === kind),
    );
    if (missing.length > 0) {
      if (run.documentTaskId) {
        if (!wanted.some((d) => d.generatedBy === run.documentTaskId))
          throw new HttpError(
            409,
            "The generated PDFs are missing or their source context changed. Retry preparation.",
          );
        this.update(run, {
          documentTaskId: undefined,
          documentIds: wanted.map((d) => d.id),
          message: "Preparing the remaining document…",
        });
        return;
      }
      const existing = this.reusableDocumentTask(run, missing);
      const task =
        existing ??
        (await this.deps.createDocuments(
          run,
          missing.length > 1
            ? "posting-application"
            : missing[0] === "resume"
              ? "posting-resume"
              : "posting-cover-letter",
        ));
      this.update(run, {
        documentTaskId: task.id,
        taskIds: [...run.taskIds, task.id],
        message: `Generating the tailored ${kindsLabel(expected)}…`,
      });
      return;
    }
    if (!this.current(run)) return;
    const application = this.store.get("application", run.applicationId);
    if (!application)
      throw new HttpError(
        409,
        "The application was removed. Preparation stopped.",
      );
    if (!application.submittedAt)
      this.store.put("application", application.id, {
        ...application,
        documentIds: wanted.map((d) => d.id),
        version: application.version + 1,
        updatedAt: now(),
      });
    this.update(run, {
      documentIds: wanted.map((d) => d.id),
      phase: run.supportedForm ? "answers" : "packaging",
      message: `${expected.length > 1 ? "PDFs are" : "The PDF is"} ready. Preparing the application answers…`,
    });
    return;
  }
  private async waitForDocumentTask(run: ApplicationPreparation) {
    if (!run.documentTaskId) return false;
    const state = this.taskState(
      run,
      run.documentTaskId,
      "Document generation",
    );
    if (state.start) {
      await this.deps.startTask(state.task.id);
      return true;
    }
    if (state.wait) return true;
    if (state.task.documentResult?.status === "failed") {
      await this.handleDocumentFailure(run, state.task);
      return true;
    }
    if (state.task.documentResult?.status !== "ready") {
      this.update(run, { message: "Rendering and validating the PDFs…" });
      return true;
    }
    return false;
  }
  private async advanceAnswers(run: ApplicationPreparation) {
    if (!run.answerTaskId) {
      const record = await this.refreshAnswerScript(run);
      if (!record) return;
      const task = await this.deps.startAnswers(record);
      if (!this.current(run)) return;
      if (task) {
        this.update(run, {
          answerTaskId: task.id,
          taskIds: [...run.taskIds, task.id],
          message: "Drafting written application answers…",
        });
        return;
      }
    } else {
      const state = this.taskState(run, run.answerTaskId, "Written answers");
      if (state.start) {
        await this.deps.startTask(state.task.id);
        return;
      }
      if (state.wait || state.task.autofillResult?.status === "saving") return;
      if (state.task.autofillResult?.status !== "ready")
        throw new HttpError(
          422,
          state.task.autofillResult?.error || "Written answers were not saved.",
        );
    }
    this.update(run, {
      phase: "packaging",
      message:
        run.scope === "answers"
          ? "Building the answers-only script…"
          : "Building the script with your PDFs and answers…",
    });
    return;
  }
  private async advancePackaging(run: ApplicationPreparation) {
    for (const id of run.documentIds)
      preparationDocument(this.store, run.openingId, id);
    const script = run.supportedForm
      ? await this.deps.generateScript(run.openingId, run.documentIds, run.id)
      : null;
    if (!this.current(run)) return;
    if (run.scope !== "answers") this.markApplicationReady(run);
    this.update(run, {
      status: "ready",
      phase: "ready",
      ...(script ? { scriptId: script.id } : {}),
      message:
        run.scope === "answers"
          ? "Answers drafted; documents not generated."
          : script
            ? "Ready for review: PDFs and autofill script are saved. Paste the script to fill the form and attach files."
            : "Your PDFs are ready to download. Complete this application on the employer’s site.",
    });
    this.store.journal(
      "application_preparation_ready",
      run.scope === "answers"
        ? "Answers-only preparation finished"
        : "Combined application preparation finished",
      run.openingId,
      {
        preparationId: run.id,
        documentIds: run.documentIds,
        scriptId: script?.id,
      },
    );
    this.store.autoExport();
    this.deps.changed();
  }
  private markApplicationReady(run: FullApplicationPreparation) {
    const application = this.store.get("application", run.applicationId);
    if (!application)
      throw new HttpError(
        409,
        "The application was removed. Preparation stopped.",
      );
    if (
      !application.submittedAt &&
      ["considering", "preparing"].includes(application.status)
    )
      this.store.put("application", application.id, {
        ...application,
        status: "ready",
        version: application.version + 1,
        updatedAt: now(),
      });
  }
  private async handleDocumentFailure(
    run: ApplicationPreparation,
    task: Pick<Task, "id" | "documentResult">,
  ) {
    if (
      await recoverDocumentOverflow(
        this.store,
        run,
        task.id,
        this.deps.followUpTask,
      )
    )
      return;
    throw new HttpError(
      422,
      task.documentResult?.error || "PDF generation failed.",
    );
  }

  private async refreshAnswerScript(run: ApplicationPreparation) {
    if (!run.scriptId || !this.store.get("application_autofill", run.scriptId))
      throw new HttpError(
        409,
        "The saved autofill script was removed. Retry preparation.",
      );
    // Document generation can outlast profile edits. Capture current answers
    // and validate/attach the finished PDFs before starting the answer task.
    const refreshed = await this.deps.generateScript(
      run.openingId,
      run.documentIds,
      run.id,
    );
    if (!this.current(run)) return undefined;
    const record = this.store.get("application_autofill", refreshed.id);
    if (!record)
      throw new HttpError(
        409,
        "The refreshed autofill script is missing. Retry preparation.",
      );
    this.update(run, { scriptId: record.id });
    return record;
  }
  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    // Requests already in flight finish before the Store is closed.
    while (this.ticking)
      await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
