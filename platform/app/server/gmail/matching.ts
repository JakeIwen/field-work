import type { Application, Opening } from "../../shared/types.js";
import {
  isNegativeReply,
  type EmployerReply,
  type GmailReplyContext,
  type ReplyClassification,
} from "../../shared/gmail.js";
import type { GmailMessage } from "./api.js";
import {
  containsGmailPhrase,
  gmailApplicationIdentity,
  gmailContextApplicationIds,
  gmailExactContact,
  gmailSenderAddress,
  needsGmailThreadContext,
} from "./correlation.js";
import {
  classifyPositiveReply,
  isActionableGmailFollowUp,
  isConditionalOrReceipt,
  isGmailBulkNoise,
} from "./positive.js";
import { classifyNegativeReply } from "./rejections.js";
import { now, sha256 } from "../storage.js";

export { gmailContextApplicationIds, needsGmailThreadContext };

export function currentEmailText(text: string) {
  return text
    .split(
      /\n(?:On .{3,200}wrote:|From:\s|[-_]{3,}\s*(?:Original|Forwarded) message)/i,
    )[0]
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

function classification(
  message: GmailMessage,
  body: string,
  includeNegative: boolean,
) {
  const negative = classifyNegativeReply(body);
  if (negative) return includeNegative ? negative : null;
  const bodyResult = classifyPositiveReply(body);
  if (
    isConditionalOrReceipt(`${message.subject}\n${body}`) &&
    !bodyResult?.clear &&
    !isActionableGmailFollowUp(body)
  )
    return null;
  return bodyResult ?? classifyPositiveReply(`${message.subject}\n${body}`);
}

type Candidate = {
  application: Application;
  role: boolean;
  explicitCompany: boolean;
  senderCompany: boolean;
  exactContact: boolean;
  fromContext: boolean;
};

function correlatedCandidates(
  message: GmailMessage,
  text: string,
  applications: Application[],
  openings: Opening[],
  allowRoleOnly: boolean,
  context?: GmailReplyContext,
) {
  const byId = new Map(openings.map((opening) => [opening.id, opening]));
  const sender = gmailSenderAddress(message.sender);
  const contextIds = new Set(context?.applicationIds ?? []);
  const all = applications.map((application): Candidate => {
    const { company, title } = gmailApplicationIdentity(application, byId);
    return {
      application,
      role: containsGmailPhrase(text, title),
      explicitCompany: containsGmailPhrase(text, company),
      senderCompany: containsGmailPhrase(message.sender, company),
      exactContact: gmailExactContact(application, sender),
      fromContext: contextIds.has(application.id),
    };
  });
  const direct = all.filter(
    (candidate) =>
      candidate.explicitCompany ||
      candidate.senderCompany ||
      candidate.exactContact,
  );
  if (direct.length) {
    const directRoles = direct.filter((candidate) => candidate.role);
    return directRoles.length ? directRoles : direct;
  }
  const contextual = all.filter((candidate) => candidate.fromContext);
  if (contextual.length) return contextual;
  if (!allowRoleOnly) return [];
  const roleOnly = all.filter((candidate) => candidate.role);
  return roleOnly.length === 1 ? roleOnly : [];
}

function matchReason(
  result: ReplyClassification,
  matches: Candidate[],
  clear: boolean,
  authenticated: boolean,
) {
  const single = matches.length === 1 ? matches[0] : undefined;
  if (clear)
    return `Explicit ${result.kind === "rejection" ? "rejection" : "invitation"}, company and role match one application; Gmail reports sender authentication passed.`;
  if (!single)
    return "More than one application could match. Review the employer and role.";
  if (!authenticated)
    return "Sender authentication could not be confirmed. Review before changing status.";
  if (single.fromContext)
    return "This message follows an application-linked Gmail thread. Review the next step and application match.";
  if (single.role && !single.explicitCompany && !single.exactContact)
    return "The exact role uniquely matches one application, but the company is not explicit. Review the match.";
  if (!result.clear)
    return isNegativeReply(result.kind)
      ? "Possible negative outcome; review the wording before marking the application rejected."
      : "Possible employer follow-up; review the wording and application match.";
  return "The message does not name both the saved company and exact role. Review the match.";
}

export type ReplyMatch = {
  reply: EmployerReply;
  certainApplicationId?: string;
};

export function matchEmployerReply(
  message: GmailMessage,
  account: string,
  applications: Application[],
  openings: Opening[],
  includeNegative = false,
  context?: GmailReplyContext,
): ReplyMatch | null {
  if (gmailSenderAddress(message.sender) === account.toLowerCase()) return null;
  const body = currentEmailText(message.text);
  const text = `${message.subject}\n${body}`;
  if (isGmailBulkNoise(text)) return null;
  const result = classification(message, body, includeNegative);
  if (!result) return null;
  const matches = correlatedCandidates(
    message,
    text,
    applications,
    openings,
    !isNegativeReply(result.kind),
    context,
  );
  if (!matches.length) return null;
  const single = matches.length === 1 ? matches[0] : undefined;
  const clear =
    !!single &&
    result.kind !== "follow_up" &&
    result.clear &&
    message.authenticated &&
    single.role &&
    single.explicitCompany;
  return {
    reply: {
      id: sha256(`${account.toLowerCase()}:${message.id}`),
      account,
      messageId: message.id,
      threadId: message.threadId,
      sender: message.sender,
      subject: message.subject,
      receivedAt: message.receivedAt,
      excerpt: body.replace(/\s+/g, " ").slice(0, 700),
      kind: result.kind,
      applicationIds: matches.map((candidate) => candidate.application.id),
      reason: matchReason(result, matches, clear, message.authenticated),
      detectedAt: now(),
    },
    certainApplicationId: clear ? single.application.id : undefined,
  };
}
