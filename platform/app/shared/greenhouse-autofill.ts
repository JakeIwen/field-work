import type {
  ApplicationAnswerProvenance,
  ApplicationFormQuestionIdentity,
  ApplicationFileSlot,
} from "./application-form.js";
import type { HostedApplicationProvider } from "./application-host.js";
import type { TaskStatus } from "./types.js";
import { isTaskBusy } from "./types.js";
import {
  answersOnlyPreparationReady,
  type ApplicationDocumentKind,
  type ApplicationPreparation,
} from "./application-preparation.js";
import { recordedAgentLabel } from "./codex-models.js";
import { referenceLetterSlot } from "./reference-letter-slot.js";

type ActivityTask = {
  status: TaskStatus;
  model?: string;
  autofillContext?: { questions?: AutofillQuestion[] };
  autofillResult?: { status: string };
};
export function greenhousePosting(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !["job-boards.greenhouse.io", "boards.greenhouse.io"].includes(
        url.hostname,
      )
    )
      return null;
    const match = /^\/([a-zA-Z0-9_-]+)\/jobs\/(\d+)\/?$/.exec(url.pathname);
    if (match) {
      const [, board, jobId] = match;
      const canonical = `https://job-boards.greenhouse.io/${board}/jobs/${jobId}`;
      return { board, jobId, url: canonical, applicationUrl: canonical };
    }
    if (
      url.pathname !== "/embed/job_app" ||
      url.searchParams.getAll("for").length !== 1 ||
      url.searchParams.getAll("token").length !== 1
    )
      return null;
    const board = url.searchParams.get("for")!,
      jobId = url.searchParams.get("token")!;
    if (!/^[a-zA-Z0-9_-]+$/.test(board) || !/^\d+$/.test(jobId)) return null;
    return {
      board,
      jobId,
      url: `https://job-boards.greenhouse.io/${board}/jobs/${jobId}`,
      applicationUrl: `https://job-boards.greenhouse.io/embed/job_app?for=${board}&token=${jobId}`,
    };
  } catch {
    return null;
  }
}

export type AutofillActivity = {
  running: boolean;
  phase: "reading-form" | "drafting" | "saving" | "idle";
  message: string;
};
export type AutofillHistoryRecord = Pick<
  AutofillRecord,
  "id" | "version" | "createdAt"
>;
export function autofillActivity(
  generating: boolean,
  tasks: ActivityTask[],
): AutofillActivity {
  const active = tasks
    .filter((t) => t.autofillContext)
    .find((t) => isTaskBusy(t.status) || t.autofillResult?.status === "saving");
  const agent = active ? recordedAgentLabel(active.model) : "The agent";
  if (
    active &&
    ["waiting for input", "waiting for approval"].includes(active.status)
  )
    return {
      running: true,
      phase: "drafting",
      message:
        active.status === "waiting for input"
          ? `${agent} needs your input. Open written answers to respond.`
          : `${agent} is waiting for approval. Open written answers to review the request.`,
    };
  if (active)
    return active.autofillResult?.status === "saving"
      ? {
          running: true,
          phase: "saving",
          message: "Saving the script with your answers…",
        }
      : {
          running: true,
          phase: "drafting",
          message: active.autofillContext?.questions?.some(
            (q) => q.mode === "unmatched",
          )
            ? `${agent} is interpreting unmatched questions using your saved facts and evidence.`
            : `${agent} is drafting written answers. You can leave this page; the completed script will be saved here.`,
        };
  return generating
    ? {
        running: true,
        phase: "reading-form",
        message: "Reading the application form and preparing your script…",
      }
    : {
        running: false,
        phase: "idle",
        message: "No autofill generation is running in the background.",
      };
}

export type AutofillReview = {
  label: string;
  required: boolean;
  reason: string;
};
export type AutofillQuestion = {
  formIdentity?: ApplicationFormQuestionIdentity;
  id: string;
  label: string;
  kind: "text" | "textarea" | "select";
  required: boolean;
  maxLength: number;
  key: string;
  mode?: "unmatched";
  options?: string[];
  profileOnly?: boolean;
  description?: string;
  profileKeys?: string[];
  notApplicable?: boolean;
  answer?: string;
  needsInput?: boolean;
  sourcePaths?: string[];
  caveats?: string[];
  taskId?: string;
  manualReviewRequired?: boolean;
  reviewReason?: string;
  answerHash?: string;
  reviewedAt?: string;
};
export type AutofillQuestionIdentity = Pick<
  AutofillQuestion,
  | "id"
  | "label"
  | "kind"
  | "required"
  | "maxLength"
  | "description"
  | "options"
  | "formIdentity"
>;
export type ApplicationAnswerReview = {
  openingId: string;
  taskId: string;
  key: string;
  answer: string;
  draftHash: string;
  reviewedAt: string;
  url?: string;
  question?: AutofillQuestionIdentity;
};
export type AutofillRecord = {
  provider?: HostedApplicationProvider;
  id: string;
  openingId: string;
  version: number;
  createdAt: string;
  url: string;
  title: string;
  openingHash: string;
  sourceHash: string;
  profileHash: string;
  helperHash: string;
  scriptHash: string;
  evidenceHash: string;
  answers: ({
    label: string;
    value: string;
  } & ApplicationAnswerProvenance)[];
  dynamicQuestions?: AutofillQuestion[];
  knowledgeHash?: string;
  answerTaskId?: string;
  answerError?: string;
  preparationId?: string;
  documentPostingHash?: string;
  /** Resume and cover-letter upload slots the inspected form has. Absent on scripts saved before 2026-11-08 (unknown). Not part of any hash. */
  documentSlots?: ApplicationDocumentKind[];
  attachments?: {
    id: string;
    label: string;
    documentId: string;
    name: string;
    hash: string;
    mime: string;
    size: number;
    slot?: ApplicationFileSlot;
  }[];
  /** Fixed workspace files the script uploads; never Opening documents. */
  sourceAttachments?: {
    id: string;
    label: string;
    sourcePath: string;
    name: string;
    hash: string;
    mime: string;
    size: number;
    slot: ApplicationFileSlot;
  }[];
  review: AutofillReview[];
  stale?: boolean;
  staleReasons?: string[];
};

/** The review reason form inspection gives every file upload slot. */
export const attachDocumentReason =
  "Attach your document on the application page.";

/** Resume and cover-letter uploads are filled by document preparation, and
 * recommendation-letter uploads by every script, not by answers. */
export const answersOnlyFinishItem = (item: AutofillReview) =>
  !(
    item.reason === attachDocumentReason &&
    (["Resume/CV", "Cover letter"].includes(item.label) ||
      referenceLetterSlot(item.label))
  );

export function autofillPreparationView(
  record: AutofillRecord,
  preparation?: ApplicationPreparation,
  drafting = false,
) {
  const pendingQuestions = (record.dynamicQuestions ?? []).filter(
    (q) =>
      !q.answer && !q.notApplicable && !q.needsInput && !q.manualReviewRequired,
  );
  // Scripts saved without a preparation (legacy, answer-only refreshes) still
  // lack the PDFs a form with upload slots asks for; only Generate Docs adds them.
  const pendingAttachments =
    !record.attachments?.length &&
    (Boolean(preparation) ||
      record.review.some((item) => item.reason === attachDocumentReason));
  const stopped =
    preparation?.status === "failed" || preparation?.status === "paused";
  const answersOnly =
    answersOnlyPreparationReady(preparation) &&
    !record.stale &&
    !record.answerError &&
    pendingQuestions.length === 0;
  const answersOnlyFinishItems = record.review.filter(answersOnlyFinishItem);
  return {
    answersOnly,
    answersOnlyFinishItems,
    incomplete:
      pendingQuestions.length > 0 || pendingAttachments || answersOnly,
    retryPreparation:
      pendingAttachments ||
      Boolean(preparation && (stopped || preparation.stale)),
    pendingLabel: stopped
      ? "Preparation stopped"
      : drafting
        ? "Preparing answer"
        : "Not prepared",
    finishItems: answersOnly
      ? answersOnlyFinishItems
      : record.review.filter(
          (item) =>
            !pendingQuestions.some((q) => q.label === item.label) &&
            !(
              pendingAttachments &&
              (item.reason === attachDocumentReason ||
                ["Resume/CV", "Cover letter"].includes(item.label))
            ),
        ),
  };
}
