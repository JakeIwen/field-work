import type { Task } from "../shared/task-records.js";
import { HttpError, MissingRecordError, type Store } from "./storage.js";

type OverflowHistory = Pick<
  Task,
  "overflowRequests" | "overflowRecovery" | "overflowRecoveryTurns"
>;
export const hasOverflowHistory = (task: OverflowHistory) =>
  !!(
    task.overflowRequests ||
    task.overflowRecovery ||
    task.overflowRecoveryTurns
  );
class UnknownOverflowTurn extends HttpError {}
export const overflowPublicationFailure = (error: unknown) =>
  error instanceof UnknownOverflowTurn ? { ownershipUnknown: true } : {};

export function identifiedOverflowRequest(
  task: OverflowHistory,
  turnId: string,
) {
  return Object.values(task.overflowRequests ?? {}).find(
    (entry) =>
      entry?.turnId === turnId &&
      (entry.kind === "repair" || entry.kind === "independent"),
  );
}

/** Scheduling eligibility only: never infer or assign ownership here. */
export function hasUnresolvedOverflowTurn(
  task: OverflowHistory &
    Pick<Task, "messages" | "activeTurnId" | "documentResult">,
) {
  const requestId = task.messages
    ?.filter((message) => message.role === "user")
    .at(-1)?.clientRequestId;
  const request = requestId ? task.overflowRequests?.[requestId] : undefined;
  if (task.activeTurnId && hasOverflowHistory(task))
    return !identifiedOverflowRequest(task, task.activeTurnId);
  if (request && !request.turnId) return true;
  const result = task.documentResult;
  if (result?.ownershipUnknown)
    return !result.turnId || !identifiedOverflowRequest(task, result.turnId);
  return false;
}

export function overflowRecoveryOwner(task: Task, turnId: string) {
  const request = identifiedOverflowRequest(task, turnId);
  if (!request && hasOverflowHistory(task))
    throw new UnknownOverflowTurn(
      409,
      "Document turn identity is unknown. Regenerate documents to continue; no repaired document was published.",
    );
  return request?.kind === "repair" ? request : undefined;
}

export function recordIndependentOverflowRequest(
  store: Store,
  id: string,
  requestId: string,
) {
  const task = store.get("task", id);
  if (!task) throw new MissingRecordError(404, "task", id, "Task missing");
  if (!hasOverflowHistory(task) || task.overflowRequests?.[requestId]) return;
  store.put("task", id, {
    ...task,
    overflowRequests: {
      ...task.overflowRequests,
      [requestId]: { kind: "independent" },
    },
  });
  store.autoExport();
}

export function withOverflowRecoveryTurn(
  task: Task,
  event: {
    method: string;
    params?: { clientRequestId?: string; turn?: { id?: string } };
  },
): Task {
  const requestId = event.params?.clientRequestId,
    turnId = event.params?.turn?.id;
  if (
    event.method !== "turn/started" ||
    typeof requestId !== "string" ||
    typeof turnId !== "string" ||
    !turnId
  )
    return task;
  const request = task.overflowRequests?.[requestId];
  if (!request || (request.turnId && request.turnId !== turnId)) return task;
  return {
    ...task,
    overflowRequests: {
      ...task.overflowRequests,
      [requestId]: { ...request, turnId },
    },
  };
}

export function acknowledgeOverflowTurn(
  store: Store,
  id: string,
  requestId: string,
  result: unknown,
) {
  if (!result || typeof result !== "object") return;
  const turn = "turn" in result ? result.turn : undefined;
  const turnId =
    turn && typeof turn === "object" && "id" in turn
      ? turn.id
      : "turnId" in result
        ? result.turnId
        : undefined;
  if (typeof turnId !== "string" || !turnId) return;
  const task = store.get("task", id);
  if (!task) throw new MissingRecordError(404, "task", id, "Task missing");
  const request = task.overflowRequests?.[requestId];
  if (!request || (request.turnId && request.turnId !== turnId)) return;
  store.put("task", id, {
    ...task,
    overflowRequests: {
      ...task.overflowRequests,
      [requestId]: { ...request, turnId },
    },
  });
  store.autoExport();
  return turnId;
}
