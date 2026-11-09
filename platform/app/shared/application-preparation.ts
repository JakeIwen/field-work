import type { ModelSelection } from "./model-selection.js";
import type { PreparationTaskActivity } from "./task-activity.js";
import type { ApplicationFileSlot } from "./application-form.js";
/** Canonical order, and the kinds a run generates when it knows nothing about the form. */
export const applicationDocumentKinds = ["resume", "cover-letter"] as const;
export type ApplicationDocumentKind = (typeof applicationDocumentKinds)[number];
export type PreparationStatus =
  "queued" | "running" | "waiting" | "ready" | "failed" | "paused";
export type PreparationPhase =
  "queued" | "form" | "documents" | "answers" | "packaging" | "ready";
/** The resume renderer's wrapped-line measurements for the overflowing page. */
export type OverflowLayout = {
  lineHeight: number;
  blocks: { text: string; lines: number; lastLineChars: number }[];
};
export type DocumentOverflow = {
  kind: ApplicationDocumentKind;
  page: number;
  points: number;
  layout?: OverflowLayout;
};
type HistoricalPreparationReview = ModelSelection & {
  trigger: "auto" | "manual";
  status: "pending" | "reviewing" | "done" | "failed";
  sourceDocumentId?: string;
  taskId?: string;
  documentId?: string;
  unchanged?: boolean;
  error?: string;
};
export type PreparationScope = "full" | "answers";
export type AnswersOnlyAutofillCount = { scope: "answers"; count: number };

type PreparationRecord = {
  id: string;
  openingId: string;
  status: PreparationStatus;
  phase: PreparationPhase;
  message: string;
  createdAt: string;
  updatedAt: string;
  openingHash: string;
  documentIds: string[];
  /** Kinds this run generates, set once the form is inspected; absent on legacy runs and sites without a form, which generate both. */
  documentKinds?: ApplicationDocumentKind[];
  replaceDocumentIds?: string[];
  documentTaskId?: string;
  answerTaskId?: string;
  scriptId?: string;
  taskIds: string[];
  error?: string;
  stale?: boolean;
  staleReasons?: string[];
  supportedForm: boolean;
  postingHash?: string;
  overflowAttempts?: Partial<Record<ApplicationDocumentKind, number>>;
  /** When each phase began, oldest first; a phase re-entered after a restart appends again. Absent on runs before 2026-11-06. */
  phaseHistory?: { phase: PreparationPhase; at: string }[];
  /** Historical metadata from the removed document-review feature; never resumed or shown. */
  review?: HistoricalPreparationReview;
};
export type FullApplicationPreparation = PreparationRecord & {
  scope?: undefined;
  applicationId: string;
};
export type ApplicationPreparation =
  | FullApplicationPreparation
  | (PreparationRecord & {
      scope: "answers";
      applicationId?: never;
    });
/** The document kinds a run generates and attaches (owner decision, 2026-11-08: no cover letter without an upload slot). */
export const preparationDocumentKinds = (
  run: Pick<PreparationRecord, "documentKinds">,
): readonly ApplicationDocumentKind[] =>
  run.documentKinds ?? applicationDocumentKinds;
/** True once the run holds one saved PDF for every kind it expects. */
export const preparationDocumentsSaved = (
  run: Pick<PreparationRecord, "documentKinds" | "documentIds">,
) => new Set(run.documentIds).size >= preparationDocumentKinds(run).length;
/** The resume and cover-letter upload slots a form inspection found, in canonical order. */
export const formDocumentSlots = (
  fileSlots: readonly Pick<ApplicationFileSlot, "kind">[],
): ApplicationDocumentKind[] =>
  applicationDocumentKinds.filter((kind) =>
    fileSlots.some((slot) => slot.kind === kind),
  );
export const answersOnlyPreparationReady = (run?: ApplicationPreparation) =>
  run?.scope === "answers" && run.status === "ready" && !run.stale;
export const preparationBusy = (run?: ApplicationPreparation) =>
  !!run && ["queued", "running", "waiting"].includes(run.status);

/** Answer of GET /api/openings/:id/preparation/activity: the Opening's latest run and its tasks' live turns. */
export type PreparationActivityResponse = {
  run: {
    id: string;
    phase: PreparationPhase;
    status: PreparationStatus;
    updatedAt: string;
  } | null;
  tasks: PreparationTaskActivity[];
};
