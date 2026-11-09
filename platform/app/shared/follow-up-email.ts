import type { ModelSelection } from "./model-selection.js";
import type { ApplicationStatus } from "./types.js";

/** Where the current draft text came from; history entries keep the same label. */
export const followUpDraftSources = [
  "generated",
  "revised",
  "edited",
  "restored",
  "reviewed",
] as const;
export type FollowUpDraftSource = (typeof followUpDraftSources)[number];
export const followUpDraftSourceLabels: Record<FollowUpDraftSource, string> = {
  generated: "Drafted",
  revised: "Revised with AI",
  edited: "Your edit",
  restored: "Restored",
  reviewed: "Reviewed by Claude",
};

/** Applications whose submission makes a follow-up email meaningful. */
export const followUpStatuses: ApplicationStatus[] = [
  "applied",
  "interviewing",
  "offer",
];
export const followUpEligible = (application: {
  status: ApplicationStatus;
  submittedAt?: string;
}) => followUpStatuses.includes(application.status);

export const followUpLimits = {
  to: 320,
  subject: 200,
  body: 8000,
  instruction: 2000,
  history: 30,
  testSends: 5,
} as const;

export type FollowUpDraft = {
  id: string;
  to: string;
  subject: string;
  body: string;
  source: FollowUpDraftSource;
  at: string;
  taskId?: string;
  turnId?: string;
  instruction?: string;
  /** Historical provenance from the removed draft-review feature. */
  review?: ModelSelection;
};

export type FollowUpRecipientSuggestion = {
  email: string;
  name?: string;
  sourceUrl: string;
  basis: string;
};

/** A recipient Fieldwork already knows from the user's own records. */
export type FollowUpRecipientCandidate = {
  email: string;
  name?: string;
  source: "application contacts" | "employer reply";
};

export const followUpVerificationStatuses = [
  "matched",
  "mismatch",
  "unverified",
] as const;
export type FollowUpVerification = {
  status: (typeof followUpVerificationStatuses)[number];
  checkedAt: string;
  detail?: string;
};

/** Gmail-confirmed sends carry Gmail's identity; "reported" means the user recorded an unconfirmed send. */
export type SentFollowUpEmail = {
  id: string;
  at: string;
  to: string;
  subject: string;
  body: string;
  draftId: string;
  verification: FollowUpVerification;
} & (
  | {
      delivery: "gmail";
      account: string;
      gmailMessageId: string;
      gmailThreadId: string;
    }
  | { delivery: "reported" }
);

/** Persisted before Gmail is called, so a crash or timeout never hides a possible send. */
export type FollowUpSending = {
  id: string;
  to: string;
  draftId: string;
  test: boolean;
  startedAt: string;
  uncertain?: boolean;
  error?: string;
};

/**
 * requested: waiting for the agent to accept the request (bounded by a grace period);
 * drafting: the agent's turn is running; failed: stopped without saving a draft.
 * "review" is retained only so historical in-flight records remain readable.
 */
export type FollowUpGenerationKind = "generate" | "revise" | "review";
export type FollowUpGeneration = {
  kind: FollowUpGenerationKind;
  status: "requested" | "drafting" | "failed";
  startedAt: string;
  requestId: string;
  taskId?: string;
  instruction?: string;
  /** The draft a revision or historical review was asked to change. */
  baseDraftId?: string;
  /** Historical provenance from the removed draft-review feature. */
  review?: ModelSelection & { trigger: "auto" | "manual" };
  error?: string;
};

export type ApplicationFollowUp = {
  id: string;
  applicationId: string;
  openingId: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  draft?: FollowUpDraft;
  /** Earlier drafts, newest first; nothing a draft replaces is lost. */
  history: FollowUpDraft[];
  suggestion?: FollowUpRecipientSuggestion;
  /** The conversation that drafted the current text and receives revision requests. */
  draftTaskId?: string;
  generation?: FollowUpGeneration;
  sending?: FollowUpSending;
  sent: SentFollowUpEmail[];
  testSends: SentFollowUpEmail[];
};

export type FollowUpGenerationView = Omit<FollowUpGeneration, "status"> & {
  status: "drafting" | "failed";
};

/** Client projection: everything except draft history, with generation status checked against its task. */
export type ApplicationFollowUpSummary = Omit<
  ApplicationFollowUp,
  "history" | "generation"
> & {
  historyCount: number;
  generation?: FollowUpGenerationView;
  recipientCandidates: FollowUpRecipientCandidate[];
};

export type FollowUpSendCapability = {
  connected: boolean;
  sendGranted: boolean;
  account?: string;
};

/** The text box contents, as saved and as sent. */
export type FollowUpTextFields = { to: string; subject: string; body: string };

/** Every follow-up route answers with this view. */
export type FollowUpView = {
  followUp: ApplicationFollowUpSummary;
  history: FollowUpDraft[];
  capability: FollowUpSendCapability;
  sent?: SentFollowUpEmail;
};

export type FollowUpSendRequest = {
  expectedVersion: number;
  draftId: string;
  testTo?: string;
};

const emailPattern =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** One plain mailbox address; display names, lists and header syntax are rejected. */
export const isFollowUpAddress = (value: string) =>
  value.length <= followUpLimits.to &&
  emailPattern.test(value) &&
  !/\.\.|^\.|\.@/.test(value);

/** Compare text the way a sent copy must reproduce it: only line endings may differ. */
export const sameEmailText = (a: string, b: string) =>
  a.replace(/\r\n?/g, "\n") === b.replace(/\r\n?/g, "\n");
