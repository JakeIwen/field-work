import { diagnosticLog } from "../diagnostic-log.js";
import {
  identifiedOverflowRequest,
  overflowPublicationFailure,
} from "../overflow-recovery-ownership.js";
import type { CodexAdapter } from "../codex.js";
import type { Task } from "../../shared/task-records.js";
import type { Store } from "../storage.js";
import { publishApplicationAnswers } from "../application-answers.js";
import { renderApplicationDocuments } from "../application-documents.js";
import { publishOpeningResearch } from "../opening-workflow.js";
import { settleFollowUpTurn } from "../follow-up-email.js";

export type AgentEvent = Parameters<
  NonNullable<ConstructorParameters<typeof CodexAdapter>[0]["onEvent"]>
>[0];
export type TaskEventServices = {
  stopping?: () => boolean;
  store: Store;
  publish: (type: string, detail?: Record<string, unknown>) => void;
  launchingTask: () => string | undefined;
  openingOperation: <T>(key: string, action: () => Promise<T>) => Promise<T>;
  generatePreparedAutofill: (id: string) => Promise<{ id: string }>;
};

export type CompletionContext = {
  services: TaskEventServices;
  task: Task;
  event: AgentEvent;
};
function isSuccessfulCompletion(
  event: AgentEvent,
): event is AgentEvent & { params: { turn: { id: string; status: string } } } {
  return (
    event.method === "turn/completed" &&
    event.params?.turn?.status === "completed"
  );
}

/** A drafting turn that ended without saving a draft becomes a visible, retryable failure. */
export function completeFollowUpEmail({
  services,
  task,
  event,
}: CompletionContext) {
  const completion = isSuccessfulCompletion(event) ? event : undefined;
  if (settleFollowUpTurn(services.store, task, !!completion)) {
    services.store.autoExport();
    services.publish("state");
  }
}

function completionTask(store: Store, id: string) {
  const task = store.get("task", id);
  if (!task)
    diagnosticLog(
      "warn",
      "task-completion",
      `Skipping completion for missing task ${id}`,
    );
  return task;
}

export function completeResearch({ services, task, event }: CompletionContext) {
  if (!isSuccessfulCompletion(event) || task.greenhousePull) return;
  try {
    publishOpeningResearch(services.store, task.id);
  } catch (error) {
    const latest = completionTask(services.store, task.id);
    if (!latest) return;
    services.store.put("task", task.id, {
      // This is the same opening-research task already checked above.
      ...(latest as Extract<Task, { preset: "opening-research" }>),
      importStatus: "failed",
      error: String(error),
    });
  }
  services.store.autoExport();
  services.publish("state");
}

export function completePostingDocuments({
  services,
  task,
  event,
}: {
  services: Pick<TaskEventServices, "store" | "publish">;
  task: Pick<Task, "id">;
  event: AgentEvent;
}): Promise<void> | undefined {
  if (!isSuccessfulCompletion(event)) return;
  return renderApplicationDocuments(
    services.store,
    task.id,
    event.params.turn.id,
  )
    .then(() => services.publish("state"))
    .catch((error) => {
      const latest = completionTask(services.store, task.id);
      if (!latest) return;
      services.store.put("task", task.id, {
        ...latest,
        documentResult: {
          ...overflowPublicationFailure(error),
          status: "failed",
          turnId: event.params.turn.id,
          error: String(error),
        },
      });
      services.store.autoExport();
      services.publish("state");
      return reconcileDocumentPublication(services, task.id);
    })
    .catch((error) =>
      diagnosticLog(
        "error",
        "task-completion",
        `Could not record document completion for task ${task.id}:`,
        {},
        error,
      ),
    );
}

export function reconcileDocumentPublication(
  services: Pick<TaskEventServices, "store" | "publish">,
  id: string,
): Promise<void> | undefined {
  const task = completionTask(services.store, id);
  const result = task?.documentResult;
  if (
    !task ||
    !result?.ownershipUnknown ||
    !result.turnId ||
    !identifiedOverflowRequest(task, result.turnId)
  )
    return;
  // Claim the retry synchronously, so identity and failure notifications cannot
  // both start it. Rendering still performs all ownership and freshness checks.
  services.store.put("task", id, {
    ...task,
    documentResult: { ...result, ownershipUnknown: false },
  });
  return completePostingDocuments({
    services,
    task,
    event: {
      method: "turn/completed",
      params: { turn: { id: result.turnId, status: "completed" } },
    },
  });
}

export function completeAutofill(
  services: TaskEventServices,
  task: Task,
  event: AgentEvent,
) {
  if (
    !isSuccessfulCompletion(event) ||
    !task.autofillContext ||
    (task.autofillResult?.turnId === event.params.turn.id &&
      ["saving", "ready"].includes(task.autofillResult!.status))
  )
    return;
  const turnId = event.params.turn.id;
  const latest = completionTask(services.store, task.id);
  if (!latest) return;
  services.store.put("task", task.id, {
    // Reloading the same immutable preset retains the narrowed questions task.
    ...(latest as Extract<Task, { preset: "questions" }>),
    autofillResult: { status: "saving", turnId },
  });
  void services
    .openingOperation(`autofill:${task.context.openingId}`, async () => {
      publishApplicationAnswers(services.store, task.id, turnId);
      const record = await services.generatePreparedAutofill(
        task.context.openingId!,
      );
      const current = completionTask(services.store, task.id);
      if (!current) return;
      services.store.put("task", task.id, {
        // Reloading the same immutable preset retains the narrowed questions task.
        ...(current as Extract<Task, { preset: "questions" }>),
        autofillResult: { status: "ready", turnId, scriptId: record.id },
      });
    })
    .catch((error) => {
      const current = completionTask(services.store, task.id);
      if (!current) return;
      services.store.put("task", task.id, {
        // Reloading the same immutable preset retains the narrowed questions task.
        ...(current as Extract<Task, { preset: "questions" }>),
        autofillResult: { status: "failed", turnId, error: String(error) },
      });
    })
    .finally(() => {
      services.store.autoExport();
      services.publish("state");
    })
    .catch((error) =>
      diagnosticLog(
        "error",
        "task-completion",
        `Could not record autofill completion for task ${task.id}:`,
        {},
        error,
      ),
    );
}
