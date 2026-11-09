import { tunableMs } from "./tunables.js";
import { diagnosticLog } from "./diagnostic-log.js";
import { setTimeout as pause } from "node:timers/promises";
import { isTaskBusy } from "../shared/types.js";
import { preparationBusy } from "../shared/application-preparation.js";
import {
  abortGenerations,
  hasActiveGenerations,
} from "./generation-control.js";
import { HttpError, now, type Store } from "./storage.js";
import type { WorkspaceRuntime } from "./task-kinds/workspace-runtime.js";
import { remainingWorkspaceWork } from "./workspace-activity.js";
import type { AppReloadStatus, ReloadWorkItem } from "../shared/app-reload.js";

export type ReloadServices = {
  store: Store;
  supported: () => boolean;
  activeThreadIds: () => string[];
  interrupt: (threadId: string) => Promise<unknown>;
  quiesce: () => Promise<unknown>;
  drainRequests: () => Promise<void>;
  shutdown: () => void;
  remainingWork?: () => ReloadWorkItem[];
};

export class WorkspaceReloader {
  active = false;
  completion: Promise<void> | undefined;
  private waiting = false;
  private remaining: ReloadWorkItem[] = [];
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly services: ReloadServices) {}

  request(whenIdle = false): AppReloadStatus {
    if (!this.services.supported())
      throw new HttpError(
        503,
        "Reload requires Fieldwork's managed background service.",
      );
    if (whenIdle && !this.services.remainingWork)
      throw new HttpError(
        503,
        "Idle work tracking is unavailable; no reload was scheduled.",
      );
    if (whenIdle && !this.active) {
      if (!this.waiting) {
        this.waiting = true;
        this.scheduleIdleCheck();
      }
      this.checkIdle();
      return this.status();
    }
    if (!this.active) {
      this.close();
      this.active = true;
      // Let the browser receive the acknowledgement before shutdown begins.
      this.completion = pause(25)
        .then(() => this.perform())
        .catch((error) => {
          diagnosticLog(
            "error",
            "workspace-reload",
            "App reload failed:",
            {},
            error,
          );
          this.flushBeforeShutdown();
        });
    }
    return this.status();
  }

  private scheduleIdleCheck() {
    const interval = tunableMs(this.services.store, "server.reloadIdleCheckMs");
    this.timer = setInterval(() => {
      this.checkIdle();
      if (
        this.waiting &&
        !this.active &&
        tunableMs(this.services.store, "server.reloadIdleCheckMs") !== interval
      ) {
        clearInterval(this.timer);
        this.scheduleIdleCheck();
      }
    }, interval);
    this.timer.unref();
  }

  status(): AppReloadStatus {
    return {
      reloading: this.active,
      waiting: this.waiting,
      pid: process.pid,
      remaining: this.remaining,
    };
  }

  checkIdle() {
    if (!this.waiting || this.active) return;
    try {
      this.remaining = this.services.remainingWork?.() ?? [];
      if (!this.remaining.length) this.request();
    } catch (error) {
      this.remaining = [
        {
          id: "checking",
          label: "Checking remaining work",
          detail: "Status could not be read; reload is still waiting.",
        },
      ];
      diagnosticLog(
        "error",
        "workspace-reload",
        "Could not check work before reload:",
        {},
        error,
      );
    }
  }

  cancel(): AppReloadStatus {
    if (this.active)
      throw new HttpError(409, "The backend is already restarting.");
    this.close();
    return this.status();
  }

  close() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.waiting = false;
    this.remaining = [];
  }

  private async interruptTurns(
    unconfirmed: Set<string>,
    interrupted: Set<string>,
  ) {
    const ids = [...new Set(this.services.activeThreadIds())];
    ids.forEach((id) => interrupted.add(id));
    const results = await Promise.allSettled(
      ids.map((id) => this.services.interrupt(id)),
    );
    ids.forEach((id, i) => {
      if (results[i].status === "rejected") unconfirmed.add(id);
      else unconfirmed.delete(id);
    });
  }

  private pausePreparations() {
    let count = 0;
    for (const run of this.services.store.list("application_preparation")) {
      if (!preparationBusy(run)) continue;
      count++;
      this.services.store.put("application_preparation", run.id, {
        ...run,
        status: "paused",
        updatedAt: now(),
        message:
          "Stopped by Reload app. Retry preparation to continue from saved work.",
      });
    }
    return count;
  }

  private flushBeforeShutdown() {
    try {
      this.services.store.flushExport();
    } catch (error) {
      diagnosticLog(
        "error",
        "workspace-reload",
        "Could not flush personal export before reload:",
        {},
        error,
      );
    }
    this.services.shutdown();
  }

  private recordInterruption(details: {
    interruptedTasks: number;
    interruptedPreparations: number;
    interruptedThreads: number;
    interruptedGeneration: boolean;
    interruptedWork: ReloadWorkItem[];
    unconfirmedInterrupts: number;
  }) {
    const stopped = [
      ...details.interruptedWork.map((work) => work.label),
      ...(details.interruptedTasks
        ? [`${details.interruptedTasks} tasks`]
        : []),
      ...(details.interruptedPreparations
        ? [`${details.interruptedPreparations} preparations`]
        : []),
      ...(details.interruptedThreads
        ? [`${details.interruptedThreads} agent threads`]
        : []),
      ...(details.interruptedGeneration ? ["file generation"] : []),
    ];
    if (stopped.length)
      this.services.store.journal(
        "app_reload",
        `Stopped generations and reloaded the app: ${stopped.join("; ")}`,
        undefined,
        details,
      );
  }

  private async perform() {
    const { store } = this.services;
    const activeIds = new Set(
      store
        .list("task")
        .filter((t) => isTaskBusy(t.status))
        .map((t) => t.id),
    );
    const interruptedGeneration = hasActiveGenerations(store);
    // These waits can finish normally; generic work labels alone do not prove interruption.
    const interruptedWork = (this.services.remainingWork?.() ?? []).filter(
      (work) =>
        ![
          "indexing",
          "follow-up-send",
          "saving",
          "preparation",
          "agent",
        ].includes(work.id),
    );
    const interruptedPreparations = this.pausePreparations();
    const draining = Promise.allSettled([
      this.services.quiesce(),
      abortGenerations(store),
    ]);
    const unconfirmed = new Set<string>();
    const interruptedThreads = new Set<string>();
    try {
      await this.interruptTurns(unconfirmed, interruptedThreads);
      await draining;
      await this.services.drainRequests();
      // A turn/start already in flight may only now have returned its thread ID.
      await this.interruptTurns(unconfirmed, interruptedThreads);
      for (const task of store.list("task")) {
        if (!activeIds.has(task.id) && !isTaskBusy(task.status)) continue;
        activeIds.add(task.id);
        const uncertain = task.threadId && unconfirmed.has(task.threadId);
        store.put("task", task.id, {
          ...task,
          status: uncertain ? "disconnected" : "interrupted",
          activeTurnId: null,
          pendingRequests: [],
          updatedAt: now(),
          error: uncertain
            ? "App reloaded; turn interruption could not be confirmed. Inspect this conversation before retrying."
            : "Generation stopped by Reload app. Saved work is available to retry.",
        });
      }
      this.recordInterruption({
        interruptedTasks: activeIds.size,
        interruptedPreparations,
        interruptedThreads: interruptedThreads.size,
        interruptedGeneration,
        interruptedWork,
        unconfirmedInterrupts: unconfirmed.size,
      });
      store.autoExport();
    } catch (error) {
      diagnosticLog(
        "error",
        "workspace-reload",
        "Could not finish app reload bookkeeping:",
        {},
        error,
      );
    } finally {
      this.flushBeforeShutdown();
    }
  }
}

export function createWorkspaceReloader(ctx: WorkspaceRuntime) {
  return new WorkspaceReloader({
    store: ctx.store,
    remainingWork: () => remainingWorkspaceWork(ctx),
    supported: () =>
      !!ctx.options.shutdown &&
      ["local.fieldwork", "fieldwork.service"].includes(
        process.env.FIELDWORK_SERVICE_LABEL ?? "",
      ),
    activeThreadIds: () => [
      ...ctx.agent
        .status()
        .threads.filter((t) => t.activeTurnId)
        .map((t) => t.id),
      ...ctx.store
        .list("task")
        .flatMap((t) =>
          isTaskBusy(t.status) && t.threadId ? [t.threadId] : [],
        ),
    ],
    interrupt: (id) => ctx.agent.interrupt(id),
    quiesce: async () => {
      clearTimeout(ctx.timer);
      ctx.scheduler.stop();
      const pull = ctx.greenhousePull?.state();
      if (pull && ["running", "cooldown"].includes(pull.status))
        ctx.greenhousePull?.action(pull.id, "pause");
      await Promise.allSettled([
        ctx.stopWatcher(),
        ctx.careers.close(),
        ctx.openingValidation.close(),
        ctx.preparation?.close(),
        ctx.greenhousePull?.close(),
        ctx.gmail.close(),
        ctx.indexing,
      ]);
    },
    drainRequests: async () => {
      while (
        ctx.taskOperations.size ||
        ctx.openingOperations.size ||
        ctx.launchingTask
      )
        await pause(25);
    },
    shutdown: () => ctx.options.shutdown?.(),
  });
}
