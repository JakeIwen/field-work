import { followWatcherTiming, watcherTiming } from "./source-watcher-timing.js";
import { tunable } from "../tunables.js";
import { diagnosticLog } from "../diagnostic-log.js";
import { preparationDocumentsSaved } from "../../shared/application-preparation.js";
import { createPreparationDocumentTask } from "../preparation-document-task.js";
import { sendOverflowFollowup } from "../overflow-followup.js";
import type { CloudAccessConfig } from "../cloud-access.js";
import {
  createWorkspaceReloader,
  type WorkspaceReloader,
} from "../workspace-reload.js";
import {
  assertGenerationActive,
  abortGenerations,
} from "../generation-control.js";
import { codexPreferences } from "../codex-selection.js";
import { taskModelRequestType } from "../../shared/codex-models.js";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import express, { type Express, type Response } from "express";
import { watch } from "chokidar";
import { isTaskBusy, type Task, type TaskStatus } from "../../shared/types.js";
import type { RescanProgress } from "../../shared/rescan-progress.js";
import { ApplicationPreparationManager } from "../application-preparation.js";
import { CareersScanManager } from "../careers/scans.js";
import { GmailManager } from "../gmail/manager.js";
import { gmailSender, type GmailSender } from "../gmail/send.js";
import { recoverInterruptedSends } from "../follow-up-email-send.js";
import { AgentRouter } from "../agent-router.js";
import { contextTool } from "../context-tools.js";
import { generateAutofill } from "../greenhouse-autofill.js";
import { GreenhousePullManager } from "../greenhouse-pull.js";
import { pullResearchRequest } from "../greenhouse-research.js";
import { importRepository } from "../importer.js";
import { fetchPosting, postingUrl } from "../job-posting.js";
import { OpeningValidationManager } from "../opening-validation.js";
import { platformBuild } from "../paths.js";
import {
  isQuestionTask,
  questionReferenceId,
  referenceFromThread,
} from "../question-context.js";
import { Scheduler } from "../scheduler.js";
import { hasActiveTaskWork } from "../workspace-activity.js";
import {
  HttpError,
  MissingRecordError,
  now,
  sha256,
  Store,
} from "../storage.js";
import { setImmediate as yieldToEvents } from "node:timers/promises";
import {
  createRegisteredTask,
  handleTaskEvent,
  taskPrompt,
  type TaskCreationBody,
  type TaskCreationOptions,
  type TaskCreationServices,
  type TaskEventServices,
} from "./registry.js";
import {
  startAutofillAnswers,
  type AutofillAnswerServices,
} from "./autofill-answers.js";
import {
  startSavedTask,
  type StartTaskBody,
  type TaskStartServices,
} from "./task-start.js";

export type WorkspaceOptions = {
  root: string;
  dataDir: string;
  port: number;
  watch?: boolean;
  connectAgent?: boolean;
  /** Read-only synthetic demos must not start scheduled integrations. */
  background?: boolean;
  shutdown?: () => void;
  staticDir?: string;
  /** Protocol fixtures only; never populated from HTTP. */
  agentFixtures?: Pick<
    ConstructorParameters<typeof AgentRouter>[0],
    "spawnProcess" | "inspectControllerProcess" | "claude"
  >;
  cloudAccess?: CloudAccessConfig | null;
  machineToken?: string;
};

// The limit appears in the message because callers do not name the field, and a
// bare "Expected bounded text" left a stopped pull with nothing to go on.
const boundedString = (value: unknown, max = 30000) => {
  if (typeof value !== "string") throw new HttpError(400, "Expected text");
  if (value.length > max)
    throw new HttpError(
      400,
      `Text is ${value.length} characters; the limit is ${max}`,
    );
  return value;
};
const boundedDate = (value: unknown) => {
  const parsed = new Date(`${value}T12:00:00Z`);
  if (
    value !== "" &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ||
      !Number.isFinite(parsed.valueOf()) ||
      parsed.toISOString().slice(0, 10) !== value)
  )
    throw new HttpError(400, "Use a valid date without a time or timezone");
  return String(value);
};
const expectedVersion = (value: unknown) => {
  if (!Number.isInteger(value) || Number(value) < 0)
    throw new HttpError(400, "expectedVersion is required");
  return Number(value);
};
function pickFields(body: any, fields: string[]) {
  return Object.fromEntries(
    fields.filter((key) => key in body).map((key) => [key, body[key]]),
  );
}

export class WorkspaceRuntime {
  readonly reloader: WorkspaceReloader;
  readonly root: string;
  readonly dataDir: string;
  readonly port: number;
  readonly staticDir: string;
  readonly options: WorkspaceOptions;
  readonly store: Store;
  readonly gmail: GmailManager;
  readonly gmailSender: GmailSender;
  /** Follow-up emails being sent right now; a reload waits for them. */
  readonly followUpSends = new Set<string>();
  readonly app: Express;
  readonly csrfToken: string;
  readonly streams: Set<Response>;
  stopping: boolean;
  indexing: Promise<any> | null;
  reindexProgress: RescanProgress | null;
  launchingTask: string | undefined;
  preparation: ApplicationPreparationManager | undefined;
  greenhousePull: GreenhousePullManager | undefined;
  referenceLoading: Promise<any> | null;
  watcher: ReturnType<typeof watch> | undefined;
  timer: NodeJS.Timeout | undefined;
  private unwatchSettings?: () => void;
  readonly taskOperations: Set<string>;
  readonly openingOperations: Set<string>;
  careers!: CareersScanManager;
  openingValidation!: OpeningValidationManager;
  scheduler!: Scheduler;
  agent!: AgentRouter;
  taskEventServices!: TaskEventServices;
  taskCreationServices!: TaskCreationServices;
  taskStartServices!: TaskStartServices;
  autofillAnswerServices!: AutofillAnswerServices;
  readonly string = boundedString;
  readonly date = boundedDate;
  readonly version = expectedVersion;
  readonly pick = pickFields;
  readonly taskPrompt = taskPrompt;

  constructor(options: WorkspaceOptions) {
    this.options = options;
    this.root = options.root;
    this.dataDir = options.dataDir;
    this.port = options.port;
    this.staticDir = path.resolve(options.staticDir ?? platformBuild);
    this.store = new Store(this.root, this.dataDir);
    this.app = express();
    this.csrfToken = randomBytes(32).toString("hex");
    this.streams = new Set<Response>();
    this.gmail = new GmailManager(this.store, this.port, () =>
      this.publish("state"),
    );
    this.gmailSender = gmailSender(this.gmail.auth.token);
    this.stopping = false;
    this.indexing = null;
    this.reindexProgress = null;
    this.launchingTask = undefined;
    this.preparation = undefined;
    this.greenhousePull = undefined;
    this.referenceLoading = null;
    this.watcher = undefined;
    this.timer = undefined;
    this.taskOperations = new Set<string>();
    this.openingOperations = new Set<string>();
    this.reloader = createWorkspaceReloader(this);
  }

  publish = (type: string, detail: any = {}) => {
    for (const stream of this.streams)
      stream.write(`data: ${JSON.stringify({ type, ...detail })}\n\n`);
  };

  reportReindex = (progress: RescanProgress | null) => {
    this.reindexProgress = progress;
    this.publish("reindex-progress", { progress });
  };

  reindex = async () => {
    if (this.indexing) return this.indexing;
    this.indexing = (async () => {
      this.reportReindex({ phase: "research" });
      const result = await importRepository(this.root, this.reportReindex, () =>
        this.store.settings(),
      );
      this.reportReindex({ phase: "saving" });
      await yieldToEvents();
      const summary = this.store.import(result);
      const imported = this.store.get("meta", "import");
      if (!imported)
        throw new MissingRecordError(
          409,
          "meta",
          "import",
          "Import metadata missing; retry the rescan",
        );
      return {
        importedAt: result.importedAt,
        summary,
        validSections: result.validSections,
        health: imported.health,
      };
    })().finally(() => {
      this.indexing = null;
      this.reportReindex(null);
      this.publish("state", { reason: "files" });
    });
    return this.indexing;
  };

  taskActive = (task: {
    status?: TaskStatus;
    documentResult?: { status: string };
  }) => isTaskBusy(task.status) || task.documentResult?.status === "rendering";

  workspaceIdle = () =>
    !this.careers.active &&
    !this.openingValidation.active &&
    !this.indexing &&
    !this.preparation?.active() &&
    !this.followUpSends.size &&
    !this.greenhousePull?.hasWork() &&
    !hasActiveTaskWork(this.store);

  initializeCareers() {
    this.careers = new CareersScanManager(
      this.store,
      () => this.publish("careers"),
      this.reindex,
    );
  }

  initializeOpeningValidation() {
    this.openingValidation = new OpeningValidationManager(this.store, () =>
      this.publish("state"),
    );
  }

  initializeScheduler() {
    this.scheduler = new Scheduler({
      store: this.store,
      scans: this.careers,
      validation: this.openingValidation,
      isIdle: this.workspaceIdle,
      prepareScan: this.reindex,
      notify: () => this.publish("state"),
    });
  }

  recoverInterruptedRenders() {
    for (const task of this.store.list("task"))
      if (task.documentResult?.status === "rendering")
        this.store.put("task", task.id, {
          ...task,
          documentResult: {
            ...task.documentResult,
            status: "failed",
            error:
              "Server restarted during PDF generation. Retry PDFs without restarting the Codex turn.",
          },
        });
  }

  recoverInterruptedAutofill() {
    for (const task of this.store.list("task"))
      if (
        task.preset === "questions" &&
        task.autofillResult?.status === "saving"
      )
        this.store.put("task", task.id, {
          ...task,
          autofillResult: {
            ...task.autofillResult,
            status: "failed",
            error:
              "Server restarted while saving application answers and autofill script. Retry Generate Docs or autofill; saved answers and PDFs were retained.",
          },
          updatedAt: now(),
        });
  }

  recoverInterruptedSends() {
    recoverInterruptedSends(this.store);
  }

  recoverBusyTasks() {
    for (const task of this.store.list("task"))
      if (isTaskBusy(task.status))
        this.store.put("task", task.id, {
          ...task,
          status: "disconnected",
          pendingRequests: [],
          error:
            "Application restarted. Reopen this conversation to inspect its saved thread; the task was not restarted.",
          updatedAt: now(),
        });
  }

  initializeAgent() {
    this.initializeAgentServices();
    this.agent = new AgentRouter({
      ...this.options.agentFixtures,
      root: this.root,
      dataDir: this.dataDir,
      referenceThreadIds: questionReferenceId ? [questionReferenceId] : [],
      tunable: (key) => tunable(this.store, key),
      ...codexPreferences(this.store),
      contextTool: (threadId, tool, args) =>
        this.dispatchAgentTool(threadId, tool, args),
      onEvent: (event) => {
        if (this.stopping) return;
        try {
          handleTaskEvent(this.taskEventServices, event);
        } catch (error) {
          diagnosticLog(
            "error",
            "workspace-runtime",
            "Task event handler failed:",
            {},
            error,
          );
        }
      },
    });
    this.initializeTaskServices();
  }

  initializeAgentServices() {
    this.taskEventServices = {
      stopping: () => this.reloader.active || this.stopping,
      store: this.store,
      publish: this.publish,
      launchingTask: () => this.launchingTask,
      openingOperation: this.openingOperation,
      generatePreparedAutofill: this.generatePreparedAutofill,
    };
  }

  initializeTaskServices() {
    this.taskStartServices = {
      store: this.store,
      agent: this.agent,
      taskOperation: this.taskOperation,
      selectedModel: this.selectedModel,
      launchingTask: () => this.launchingTask,
      setLaunchingTask: (id) => {
        this.launchingTask = id;
      },
      publish: this.publish,
    };
    this.taskCreationServices = {
      store: this.store,
      string: this.string,
      pick: this.pick,
      documents: this.documents,
      questionReference: this.questionReference,
      suppliedPosting: this.suppliedPosting,
      publish: this.publish,
      startSavedTask: (id, body) =>
        startSavedTask(this.taskStartServices, id, body, 409),
    };
    this.autofillAnswerServices = {
      store: this.store,
      taskActive: this.taskActive,
      createTask: this.createTask,
    };
  }

  dispatchAgentTool = (
    threadId: string,
    tool: string,
    args: Parameters<typeof contextTool>[3],
  ) => {
    assertGenerationActive(this.store);
    const task = this.store.taskForThread(threadId);
    if (task && task.threadId !== threadId)
      throw new HttpError(409, "This thread is no longer current.");
    return contextTool(this.store, threadId, tool, args);
  };

  connectAgent() {
    if (this.options.connectAgent !== false)
      void this.agent.connect().catch(() => this.publish("agent"));
  }

  changed = (res: Response, value: any) => {
    this.store.autoExport();
    this.publish("state");
    res.json(value);
  };

  documents = (ids: any) => {
    if (
      !Array.isArray(ids) ||
      ids.length > 30 ||
      !ids.every((value) => typeof value === "string")
    )
      throw new HttpError(400, "Select document IDs");
    return [...new Set<string>(ids)].map((id) => {
      const document = this.store.document(id);
      if (!document) throw new HttpError(404, "Document version missing");
      if (document.status === "rejected")
        throw new HttpError(
          400,
          "Rejected documents cannot be used in an application package",
        );
      return document;
    });
  };

  assertPackageReady = (selected: any[]) => {
    if (!selected.length)
      throw new HttpError(400, "Select an explicit document package first");
    const conflicts = (this.store.get("meta", "import")?.health ?? []).filter(
      (issue: any) =>
        issue.severity === "error" &&
        /content-conflict|master-conflict/.test(issue.category),
    );
    for (const document of selected) {
      const conflict =
        document.availableInSource !== false &&
        conflicts.find((issue: any) =>
          (issue.paths ?? []).some(
            (source: string) =>
              source === document.path ||
              path.posix.dirname(source) === path.posix.dirname(document.path),
          ),
        );
      if (conflict)
        throw new HttpError(
          409,
          `Selected resume has a source or private/public content conflict: ${conflict.message} Resolve it before making a ready package.`,
        );
      if (
        document.format === "pdf" &&
        readFileSync(this.store.objectPath(document.hash))
          .subarray(0, 4)
          .toString() !== "%PDF"
      )
        throw new HttpError(
          409,
          "Selected PDF is invalid; restore or regenerate it before using this package.",
        );
    }
  };

  questionReference = async (refresh = false) => {
    if (!questionReferenceId) return null;
    const existing = this.store.get("reference_context", questionReferenceId);
    if (existing && !refresh) return existing;
    if (this.referenceLoading) return this.referenceLoading;
    this.referenceLoading = this.loadQuestionReference().finally(() => {
      this.referenceLoading = null;
    });
    return this.referenceLoading;
  };

  loadQuestionReference = async () => {
    let reference;
    try {
      const result = await this.agent.readReferenceThread(questionReferenceId);
      reference = referenceFromThread(result.thread);
    } catch (error) {
      diagnosticLog(
        "warn",
        "workspace-runtime",
        "Optional reference conversation is unavailable; continuing without it.",
        {},
        error,
      );
      return null;
    }
    this.store.put("reference_context", questionReferenceId, reference);
    this.store.autoExport();
    return reference;
  };

  suppliedPosting = async (body: any) => {
    if (body.postingTaskId) {
      const source = this.store.get(
        "task",
        this.string(body.postingTaskId, 100),
      );
      if (!source?.posting || !isQuestionTask(source.preset))
        throw new HttpError(400, "The selected conversation has no posting");
      return source.posting;
    }
    const text = this.string(body.postingText ?? "", 60000).trim();
    const url = body.postingUrl
      ? postingUrl(this.string(body.postingUrl, 3000)).href
      : "";
    if (text) return this.pastedPosting(body, text, url);
    if (url) return fetchPosting(url);
    return null;
  };

  pastedPosting(
    body: { postingPreviewId?: unknown },
    text: string,
    url: string,
  ) {
    const preview =
      typeof body.postingPreviewId === "string"
        ? this.store.get("posting_preview", body.postingPreviewId)
        : null;
    if (preview && preview.text.trim() === text && preview.url === url)
      return preview;
    return {
      kind: "pasted",
      url: url || null,
      text,
      hash: sha256(text),
      capturedAt: now(),
    };
  }

  createTask = (
    body: TaskCreationBody,
    options: TaskCreationOptions = {},
  ): Promise<Task | undefined> => {
    assertGenerationActive(this.store);
    return createRegisteredTask(this.taskCreationServices, body, options);
  };

  initializeGreenhousePull() {
    this.greenhousePull = new GreenhousePullManager(this.store, {
      autoStart: this.options.background !== false,
      notify: () => this.publish("state"),
      interruptTask: (id) => {
        const task = this.store.get("task", id);
        if (!task?.threadId) {
          diagnosticLog(
            "warn",
            "workspace-runtime",
            `Skipping interruption for missing task/thread ${id}`,
          );
          return Promise.resolve();
        }
        return this.agent.interrupt(task.threadId);
      },
      createResearch: (run, candidate) =>
        this.createTask(pullResearchRequest(candidate), {
          greenhouseContext: { run, candidate },
        }),
      defaultModel: () => {
        const catalog = this.agent.modelCatalogStatus();
        const defaults = catalog.models.filter(
          (model) => model.provider !== "claude" && model.isDefault,
        );
        return !catalog.error && defaults.length === 1
          ? defaults[0].model
          : undefined;
      },
      startTask: (id, selection) =>
        this.launchingTask
          ? Promise.resolve(this.store.get("task", id))
          : this.startSavedTask(id, { ...selection, transientModel: true }),
    });
  }

  openingOperation = async <T>(key: string, action: () => Promise<T>) => {
    assertGenerationActive(this.store);
    if (this.openingOperations.has(key))
      throw new HttpError(
        409,
        "This Opening is already being prepared. Its progress will appear here.",
      );
    this.openingOperations.add(key);
    try {
      return await action();
    } finally {
      this.openingOperations.delete(key);
    }
  };

  startAutofillAnswers = (
    record: Parameters<typeof startAutofillAnswers>[1],
    regenerate = false,
  ) => startAutofillAnswers(this.autofillAnswerServices, record, regenerate);

  generatePreparedAutofill = async (
    id: string,
    documentIds?: string[],
    preparationId?: string,
  ) => {
    const current = this.preparation?.latest(id);
    const reusable =
      current && !current.stale && preparationDocumentsSaved(current)
        ? current
        : undefined;
    return generateAutofill(this.store, id, undefined, {
      documentIds: documentIds ?? reusable?.documentIds ?? [],
      preparationId: preparationId ?? reusable?.id,
    });
  };

  initializePreparation() {
    this.preparation = new ApplicationPreparationManager(this.store, {
      followUpTask: (id, prompt, requestId, guard) =>
        sendOverflowFollowup(this, id, prompt, requestId, guard),
      changed: () => this.publish("state"),
      generateScript: (id, ids, runId) =>
        this.openingOperation(`autofill:${id}`, () =>
          this.generatePreparedAutofill(id, ids, runId),
        ),
      createDocuments: (run, preset) =>
        this.createPreparationDocuments(run, preset),
      startTask: (id) =>
        this.launchingTask
          ? Promise.resolve(this.store.get("task", id))
          : this.startSavedTask(id, {}),
      startAnswers: (record) => this.startAutofillAnswers(record),
    });
  }

  createPreparationDocuments = (
    run: Parameters<typeof createPreparationDocumentTask>[1],
    preset: string,
  ) => createPreparationDocumentTask(this, run, preset);

  taskOperation = async <T>(id: string, run: () => Promise<T>) => {
    assertGenerationActive(this.store);
    if (this.taskOperations.has(id))
      throw new HttpError(
        409,
        "A request for this task is already in progress. Reload its state before retrying.",
      );
    this.taskOperations.add(id);
    try {
      return await run();
    } finally {
      this.taskOperations.delete(id);
    }
  };

  selectedModel = (body: StartTaskBody) => ({
    ...(body.model ? { model: this.string(body.model, 150) } : {}),
    ...(body.effort ? { effort: this.string(body.effort, 30) } : {}),
  });

  startSavedTask = (id: string, body: StartTaskBody) =>
    startSavedTask(this.taskStartServices, id, body);

  startScheduler() {
    this.scheduler.start();
    this.gmail.startBackground();
  }

  stopWatcher() {
    clearTimeout(this.timer);
    this.unwatchSettings?.();
    this.unwatchSettings = undefined;
    const watcher = this.watcher;
    this.watcher = undefined;
    return watcher?.close();
  }

  private scheduleWatcherReindex = () => {
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () =>
        void this.reindex().catch((error) => {
          this.store.journal("import_error", String(error));
          this.publish("state");
        }),
      600,
    );
  };

  startWatcher(reconcile = false) {
    if (this.options.watch === false || this.stopping) return;
    const timing = watcherTiming(this.store);
    this.unwatchSettings?.();
    this.unwatchSettings = followWatcherTiming(this.store, timing, {
      watcher: () => this.watcher,
      stopping: () => this.stopping,
      restart: () => this.startWatcher(true),
    });
    this.watcher = watch(
      [
        "company_careers",
        "source_data",
        "source_master_template",
        "employer_specific",
        "old_resume",
        "AGENTS.md",
      ].map((source) => path.join(this.root, source)),
      {
        ignoreInitial: true,
        usePolling: true,
        ...timing,
        ignored: (source, stats) =>
          !!stats?.isFile() && !/\.(md|txt|json|html|pdf)$/.test(source),
      },
    );
    this.watcher.on("error", (error) => {
      this.store.journal("watcher_error", String(error));
      this.publish("state", {
        error: "File watcher unavailable; use Rescan files.",
      });
    });
    this.watcher.on("all", this.scheduleWatcherReindex);
    if (reconcile) {
      // Re-read files changed while the polling watcher was being replaced.
      this.watcher.once("ready", this.scheduleWatcherReindex);
    }
  }

  close = async () => {
    if (this.stopping) return;
    this.stopping = true;
    this.reloader.close();
    await abortGenerations(this.store);
    await this.gmail.close();
    clearTimeout(this.timer);
    await this.stopWatcher();
    await this.indexing?.catch(() => {});
    this.scheduler.stop();
    await this.careers.close();
    await this.openingValidation.close();
    await this.greenhousePull?.close();
    await this.preparation?.close();
    await this.agent.close();
    for (const stream of this.streams) stream.end();
    this.store.close();
  };
}
