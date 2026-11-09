import { tunable } from "./tunables.js";
import {
  overflowRecoveryOwner,
  hasOverflowHistory,
} from "./overflow-recovery-ownership.js";
import {
  applicationDocumentKinds,
  type ApplicationPreparation,
  type DocumentOverflow,
} from "../shared/application-preparation.js";
import type { Task, Bundle, OverflowRequest } from "../shared/task-records.js";
import { documentOpeningHash } from "./preparation-documents.js";
import { checkSources } from "./bundles.js";
import { overflowLayoutGuidance, overflowPoints } from "./overflow-layout.js";
import { assertGenerationActive } from "./generation-control.js";
import { HttpError, MissingRecordError, now, type Store } from "./storage.js";

export type OverflowFollowup = (
  id: string,
  prompt: string,
  requestId: string,
  guard: () => void,
) => Promise<unknown>;

export function assertOverflowRecoveryActive(
  store: Store,
  id: string,
  turnId: string,
) {
  assertGenerationActive(store);
  const task = store.get("task", id);
  if (!task)
    throw new MissingRecordError(409, "task", id, "Document task was removed.");
  const recovery = overflowRecoveryOwner(task, turnId);
  if (!recovery) return;
  return activeRepairRun(store, id, recovery);
}

function activeRepairRun(
  store: Store,
  id: string,
  recovery: OverflowRequest | undefined,
) {
  assertGenerationActive(store);
  const run =
    recovery?.kind === "repair"
      ? store.get("application_preparation", recovery.preparationId)
      : undefined;
  if (
    recovery?.kind !== "repair" ||
    recovery.cancelled ||
    !run ||
    run.scope === "answers" ||
    run.phase !== "documents" ||
    !["running", "waiting"].includes(run.status) ||
    run.documentTaskId !== id
  )
    throw new HttpError(
      409,
      "Overflow recovery was cancelled or its preparation was removed. No document was published.",
    );
  if (!store.opening(run.openingId))
    throw new MissingRecordError(
      409,
      "opening",
      run.openingId,
      "Overflow recovery's Opening was removed. No document was published.",
    );
  if (!store.get("application", run.applicationId))
    throw new MissingRecordError(
      409,
      "application",
      run.applicationId,
      "Overflow recovery's application was removed. No document was published.",
    );
  return run;
}

export function assertOverflowPublicationFresh(
  store: Store,
  task: Task,
  capturedBundle: Bundle,
  turnId: string,
) {
  const run = assertOverflowRecoveryActive(store, task.id, turnId);
  if (!run) return;
  const opening = store.opening(run.openingId);
  if (!opening)
    throw new MissingRecordError(
      409,
      "opening",
      run.openingId,
      "Opening was removed before publication.",
    );
  const currentHash = documentOpeningHash(opening);
  if (
    currentHash !== run.openingHash ||
    (task.preparationOpeningHash && currentHash !== task.preparationOpeningHash)
  )
    throw new HttpError(
      409,
      "The Opening changed during PDF generation. No repaired document was published; retry preparation.",
    );
  const conflicts = checkSources(store, capturedBundle, true);
  if (conflicts.length)
    throw new HttpError(
      409,
      `Authoritative sources changed during PDF generation: ${conflicts.map((conflict) => conflict.path).join(", ")}. No repaired document was published; start a fresh draft.`,
    );
}

export function cancelOverflowRecovery(store: Store, id: string) {
  const task = store.get("task", id);
  if (!task || !hasOverflowHistory(task)) return;
  store.put("task", id, {
    ...task,
    ...(task.overflowRecovery
      ? { overflowRecovery: { ...task.overflowRecovery, cancelled: true } }
      : {}),
    overflowRequests: Object.fromEntries(
      Object.entries(task.overflowRequests ?? {}).map(([key, request]) => [
        key,
        request.kind === "repair" ? { ...request, cancelled: true } : request,
      ]),
    ),
    updatedAt: now(),
  });
  store.autoExport();
}

function overflowPrompt(overflow: DocumentOverflow, targets: number) {
  const points = overflowPoints(overflow.points);
  return [
    `The trusted renderer rejected the ${overflow.kind}: Page ${overflow.page} overflowed by ${points} points. Shorten only that document enough to remove at least ${points} points of vertical overflow on that page, leaving a small safety margin. Preserve required content, supported facts, readable complete sentences, paragraph structure, and the captured writing rules. Keep the resume Markdown and private HTML synchronized when applicable. Do not change fonts, margins, renderer code, page limits, or validators. Do not edit the other document. If required content cannot fit safely, explain the conflict instead of removing it. Your claim of fitting is not validation: Fieldwork will re-render and validate the saved source.`,
    overflowLayoutGuidance(overflow, targets),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function validateOverflowDraft(
  store: Store,
  task: Task,
  overflow: DocumentOverflow,
) {
  if (
    !applicationDocumentKinds.includes(overflow.kind) ||
    !Number.isSafeInteger(overflow.page) ||
    overflow.page < 1 ||
    !Number.isFinite(overflow.points) ||
    overflow.points <= 0
  )
    throw new HttpError(409, "Invalid saved renderer overflow measurement.");
  if (!task.threadId)
    throw new HttpError(
      409,
      "Overflow recovery needs the saved drafting conversation.",
    );
  const bundle = store.get("bundle", task.id);
  if (!bundle)
    throw new MissingRecordError(
      409,
      "bundle",
      task.id,
      "Document draft bundle was removed.",
    );
  const conflicts = checkSources(store, bundle, true);
  if (conflicts.length)
    throw new HttpError(
      409,
      `Original sources changed since the draft began: ${conflicts.map((c) => c.path).join(", ")}. Start a new document draft with current sources.`,
    );
}

export async function recoverDocumentOverflow(
  store: Store,
  run: ApplicationPreparation,
  taskId: string,
  followUp?: OverflowFollowup,
) {
  const task = store.get("task", taskId);
  const result = task?.documentResult,
    overflow = result?.overflow;
  if (!task || !overflow || !result?.turnId || !followUp) return false;
  assertOverflowRecoveryActive(store, task.id, result.turnId);
  if (
    Object.values(task.overflowRequests ?? {}).some(
      (request) =>
        request.kind === "repair" &&
        request.preparationId === run.id &&
        request.failedTurnId === result.turnId,
    )
  )
    return true;
  validateOverflowDraft(store, task, overflow);
  const current = store.get("application_preparation", run.id);
  if (!current || current.phase !== "documents" || current.status !== "running")
    return true;
  const maxOverflowAttempts = tunable(
    store,
    "autofill.overflowShortenAttempts",
  );
  const attempts = current.overflowAttempts?.[overflow.kind] ?? 0;
  if (attempts >= maxOverflowAttempts)
    throw new HttpError(
      422,
      `${result.error || "PDF generation failed."}\nAutomatic shortening stopped after ${maxOverflowAttempts} attempts for ${overflow.kind}. Page ${overflow.page} overflowed by ${overflowPoints(overflow.points)} points.`,
    );
  const failedTurnId = result.turnId;
  const requestId = `overflow:${run.id}:${overflow.kind}:${attempts + 1}`;
  store.transaction(() => {
    store.put("application_preparation", run.id, {
      ...current,
      overflowAttempts: {
        ...current.overflowAttempts,
        [overflow.kind]: attempts + 1,
      },
      message: `Shortening ${overflow.kind} after page ${overflow.page} overflow (${overflowPoints(overflow.points)} points); attempt ${attempts + 1}/${maxOverflowAttempts}.`,
      updatedAt: now(),
    });
    store.put("task", task.id, {
      ...task,
      overflowRequests: {
        ...task.overflowRequests,
        [requestId]: { kind: "repair", preparationId: run.id, failedTurnId },
      },
    });
  });
  store.autoExport();
  await followUp(
    task.id,
    overflowPrompt(overflow, tunable(store, "autofill.overflowTargets")),
    requestId,
    () =>
      activeRepairRun(
        store,
        task.id,
        store.get("task", task.id)?.overflowRequests?.[requestId],
      ),
  );
  return true;
}
