import { taskModelRequestType } from "../../shared/codex-models.js";
import { existsSync } from "node:fs";
import type { Task } from "../../shared/types.js";
import { draftPath } from "../bundles.js";
import type { AgentRouter } from "../agent-router.js";
import { HttpError, MissingRecordError, now, type Store } from "../storage.js";
import { taskPrompt, taskPurposeSelection } from "./registry.js";
import { TaskLaunchBusy } from "./task-launch.js";

// Retain the existing loose HTTP/body boundary for model selection.
export type StartTaskBody = any;

export type TaskStartServices = {
  store: Store;
  agent: AgentRouter;
  taskOperation: <T>(id: string, run: () => Promise<T>) => Promise<T>;
  selectedModel: (body: StartTaskBody) => {
    model?: string;
    effort?: string;
  };
  launchingTask: () => string | undefined;
  setLaunchingTask: (id: string | undefined) => void;
  publish: (type: string, detail?: Record<string, unknown>) => void;
};

type StartResult = Awaited<ReturnType<AgentRouter["start"]>>;

export function startSavedTask(
  services: TaskStartServices,
  id: string,
  body: StartTaskBody,
  missingStatus: 404 | 409 = 404,
) {
  return services.taskOperation(id, () =>
    runStartTask(services, id, body, missingStatus),
  );
}

async function runStartTask(
  services: TaskStartServices,
  id: string,
  body: StartTaskBody,
  missingStatus: 404 | 409,
) {
  const task = validateTaskStart(services, id, missingStatus);
  const selection = {
    ...services.selectedModel(body),
    ...taskPurposeSelection(task),
    requestType: taskModelRequestType(task),
  };
  services.setLaunchingTask(id);
  try {
    await services.agent.connect();
    if (!services.agent.status().available)
      return saveUnavailableTask(services, task, missingStatus);
    if (!services.store.get("task", id)) throw missingTask(id, missingStatus);
    const initialMessage = queueInitialMessage(services.store, task);
    const result = await services.agent.start({
      prompt: taskPrompt(task),
      cwd: draftPath(services.store, id),
      ...selection,
      transientModel: body.transientModel === true,
    });
    saveStartedTask(
      services.store,
      id,
      initialMessage.id,
      result,
      missingStatus,
    );
  } catch (error) {
    if (error instanceof MissingRecordError) throw error;
    saveFailedStart(services, id, error, missingStatus);
  } finally {
    services.setLaunchingTask(undefined);
    services.store.autoExport();
    services.publish("state");
  }
  const saved = services.store.get("task", id);
  if (!saved) throw missingTask(id, missingStatus);
  return saved;
}

function missingTask(id: string, status: 404 | 409) {
  return new MissingRecordError(status, "task", id, "Task missing");
}

function validateTaskStart(
  services: TaskStartServices,
  id: string,
  missingStatus: 404 | 409,
) {
  const task = services.store.get("task", id);
  if (!task) throw missingTask(id, missingStatus);
  if (task.threadId)
    throw new HttpError(
      409,
      "This task already has a saved conversation. Resume it or send a follow-up; a second thread was not created.",
    );
  if (!task.manifest)
    throw new HttpError(
      409,
      "Saved context or draft files are missing. Restore the bundle before starting.",
    );
  if (!services.store.get("bundle", id))
    throw new MissingRecordError(
      409,
      "bundle",
      id,
      "Saved context or draft files are missing. Restore the bundle before starting.",
    );
  if (!draftExists(services.store, id))
    throw new HttpError(
      409,
      "Saved context or draft files are missing. Restore the bundle before starting.",
    );
  if (services.launchingTask()) throw new TaskLaunchBusy();
  return task;
}

function draftExists(store: Store, id: string) {
  return existsSync(draftPath(store, id));
}

function saveUnavailableTask(
  services: TaskStartServices,
  task: Task,
  missingStatus: 404 | 409,
) {
  if (!services.store.get("task", task.id))
    throw missingTask(task.id, missingStatus);
  services.store.put("task", task.id, {
    ...task,
    mode: "live",
    status: "unavailable",
    error:
      services.agent.status().reason ??
      "No agent is available. Export the task prompt and manifest.",
    updatedAt: now(),
    version: task.version + 1,
  });
  return services.store.get("task", task.id);
}

function queueInitialMessage(store: Store, task: Task) {
  const initialMessage = {
    id: `${task.id}:initial`,
    role: "user",
    text: task.prompt,
    at: now(),
    delivery: "queued",
  };
  store.put("task", task.id, {
    ...task,
    mode: "live",
    status: "queued",
    error: null,
    messages: [
      ...(task.messages ?? []).filter(
        (message: any) => message.id !== initialMessage.id,
      ),
      initialMessage,
    ],
    updatedAt: now(),
    version: task.version + 1,
  });
  return initialMessage;
}

function saveStartedTask(
  store: Store,
  id: string,
  initialMessageId: string,
  result: StartResult,
  missingStatus: 404 | 409,
) {
  const latest = store.get("task", id);
  if (!latest) throw missingTask(id, missingStatus);
  const completedAlready = ["completed", "failed", "interrupted"].includes(
    latest.status,
  );
  store.put("task", id, {
    ...latest,
    threadId: result.threadId,
    status: latest.status === "queued" ? "running" : latest.status,
    activeTurnId: completedAlready ? null : result.turnId,
    messages: latest.messages.map((message: any) =>
      message.id === initialMessageId
        ? {
            ...message,
            delivery: "sent",
            model: latest.model,
            effort: latest.effort,
            turnId: result.turnId,
          }
        : message,
    ),
    updatedAt: now(),
    version: latest.version + 1,
  });
}

function saveFailedStart(
  services: TaskStartServices,
  id: string,
  error: unknown,
  missingStatus: 404 | 409,
) {
  const latest = services.store.get("task", id);
  if (!latest) throw missingTask(id, missingStatus);
  services.store.put("task", id, {
    ...latest,
    status: latest.threadId
      ? "disconnected"
      : services.agent.status().available
        ? "failed"
        : "unavailable",
    error: String(error),
    messages: (latest.messages ?? []).map((message: any) =>
      message.id === `${id}:initial`
        ? { ...message, delivery: latest.threadId ? "unknown" : "failed" }
        : message,
    ),
    updatedAt: now(),
    version: latest.version + 1,
  });
}
