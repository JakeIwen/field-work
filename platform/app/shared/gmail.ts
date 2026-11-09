import type { ApplicationStatus } from "./types.js";

export const employerReplyKinds = [
  "interview",
  "assessment",
  "offer",
  "follow_up",
  "rejection",
  "negative",
] as const;
export type EmployerReplyKind = (typeof employerReplyKinds)[number];
export const employerReplyLabels: Record<EmployerReplyKind, string> = {
  interview: "Interview invitation",
  assessment: "Assessment request",
  offer: "Job offer",
  follow_up: "Employer follow-up",
  rejection: "Rejection",
  negative: "Other negative reply",
};
export const isNegativeReply = (kind: EmployerReplyKind) =>
  kind === "rejection" || kind === "negative";
export type GmailReplyContext = { applicationIds: string[] };
export type ReplyClassification = { kind: EmployerReplyKind; clear: boolean };
export type EmployerReply = {
  id: string;
  messageId: string;
  account: string;
  threadId: string;
  sender: string;
  subject: string;
  receivedAt: string;
  excerpt: string;
  kind: EmployerReplyKind;
  applicationIds: string[];
  reason: string;
  detectedAt: string;
  reviewedAt?: string;
  pendingApplicationId?: string;
  update?: {
    applicationId: string;
    from: ApplicationStatus;
    to: ApplicationStatus;
    at: string;
  };
};
export type GmailScan = {
  account: string;
  lastAttemptAt?: string;
  lastCheckedAt?: string;
  retryAt?: string;
  error?: string;
  /** The error needs a new Google authorization rather than a retry. */
  reconnect?: boolean;
  lastIncludedNegative?: boolean;
  lastScanVersion?: number;
  pending?: {
    query: string;
    through: string;
    pageToken?: string;
    seenPageTokens?: string[];
    checked: number;
    includeNegative?: boolean;
    scanVersion?: number;
  };
};
export type GmailState = GmailPreferences & {
  configured: boolean;
  connected: boolean;
  filterSettingsGranted: boolean;
  sendGranted: boolean;
  account?: string;
  checking: boolean;
  lastCheckedAt?: string;
  retryAt?: string;
  error?: string;
  reconnectRequired?: boolean;
  hasMore: boolean;
  checked: number;
  needsNegativeBackfill: boolean;
  needsRescan: boolean;
  nextCheckAt?: string;
  replies: EmployerReply[];
};
export type GmailPreferences = {
  enabled: boolean;
  autoUpdate: boolean;
  includeNegative: boolean;
};

export function gmailMessageUrl(
  reply: Pick<EmployerReply, "account" | "messageId">,
) {
  return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(reply.account)}#all/${encodeURIComponent(reply.messageId)}`;
}
