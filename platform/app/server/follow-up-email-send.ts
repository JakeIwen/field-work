import { randomUUID } from "node:crypto";
import {
  followUpLimits,
  isFollowUpAddress,
  sameEmailText,
  type ApplicationFollowUp,
  type FollowUpDraft,
  type FollowUpSendCapability,
  type FollowUpSendRequest,
  type FollowUpSending,
  type FollowUpVerification,
  type SentFollowUpEmail,
} from "../shared/follow-up-email.js";
import type { Application } from "../shared/types.js";
import {
  assertNotBusy,
  changeFollowUp,
  followUpApplication,
} from "./follow-up-email.js";
import {
  buildRawEmail,
  mailboxAddresses,
  parseRawEmail,
  type ParsedEmail,
} from "./gmail/mime.js";
import { readAutofillProfile } from "./autofill/profile.js";
import { plainTextHtml } from "./email-html.js";
import { GmailSendUncertain, type GmailSender } from "./gmail/send.js";
import { HttpError, now, type Store } from "./storage.js";

export type FollowUpSendServices = {
  store: Store;
  capability: () => FollowUpSendCapability;
  sender: GmailSender;
  /** Sends in flight in this process, for reload idle checks. */
  active: Set<string>;
  /** Export and publish; called when the in-flight marker is saved and when the send settles. */
  changed: () => void;
};

const snippet = (text: string, at: number) =>
  JSON.stringify(text.slice(Math.max(0, at - 12), at + 12));

function difference(label: string, expected: string, actual: string) {
  const a = expected.replace(/\r\n?/g, "\n");
  const b = actual.replace(/\r\n?/g, "\n");
  let at = 0;
  while (at < a.length && a[at] === b[at]) at++;
  return `${label} differs at character ${at + 1}: the draft has ${snippet(a, at)}, Gmail stored ${snippet(b, at)}.`;
}

/** Exactly one plain-text and one HTML version, so the checked copy is the one every app shows. */
function versionProblems(parsed: ParsedEmail, expectedHtml: string) {
  const { plain, html } = parsed.versions;
  if (plain !== 1 || html !== 1)
    return [
      `Gmail's copy has ${plain} plain-text and ${html} formatted (HTML) versions instead of one of each.`,
    ];
  return sameEmailText(parsed.html!, expectedHtml)
    ? []
    : [difference("The formatted (HTML) version", expectedHtml, parsed.html!)];
}

/** Compare Gmail's stored copy with what the user saved, character for character, in both versions. */
export async function verifySentCopy(
  sender: GmailSender,
  messageId: string,
  expected: { to: string; subject: string; body: string },
): Promise<FollowUpVerification> {
  const checkedAt = now();
  try {
    const parsed = parseRawEmail(await sender.raw(messageId));
    const recipients = mailboxAddresses(parsed.to);
    const problems = [
      ...(parsed.subject === expected.subject
        ? []
        : [difference("The subject", expected.subject, parsed.subject)]),
      ...(sameEmailText(parsed.text, expected.body)
        ? []
        : [difference("The body", expected.body, parsed.text)]),
      ...versionProblems(parsed, plainTextHtml(expected.body)),
      ...(recipients.length === 1 &&
      recipients[0].toLowerCase() === expected.to.toLowerCase()
        ? []
        : [
            `Gmail's copy is addressed to ${JSON.stringify(parsed.to)}, not only ${expected.to}.`,
          ]),
    ];
    return problems.length
      ? { status: "mismatch", checkedAt, detail: problems.join(" ") }
      : { status: "matched", checkedAt };
  } catch (error) {
    return {
      status: "unverified",
      checkedAt,
      detail: `Sent, but Gmail's stored copy could not be checked: ${(error as Error).message}`,
    };
  }
}

export function followUpSendRequest(body: unknown): FollowUpSendRequest {
  const value = (body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(value.expectedVersion))
    throw new HttpError(400, "expectedVersion is required");
  if (typeof value.draftId !== "string" || !value.draftId)
    throw new HttpError(400, "draftId is required");
  if (value.testTo === undefined)
    return {
      expectedVersion: Number(value.expectedVersion),
      draftId: value.draftId,
    };
  const testTo = typeof value.testTo === "string" ? value.testTo.trim() : "";
  if (!isFollowUpAddress(testTo))
    throw new HttpError(
      400,
      "Enter one valid email address for the test copy.",
    );
  return {
    expectedVersion: Number(value.expectedVersion),
    draftId: value.draftId,
    testTo,
  };
}

type ReservedSend = {
  application: Application;
  draft: FollowUpDraft;
  sending: FollowUpSending;
  account: string;
};

/** Persist the in-flight marker first, so no outcome can disappear; the draft sent is the one the user confirmed. */
function reserveSend(
  services: FollowUpSendServices,
  applicationId: string,
  request: FollowUpSendRequest,
): ReservedSend {
  const application = followUpApplication(services.store, applicationId);
  const capability = services.capability();
  if (!capability.connected || !capability.sendGranted || !capability.account)
    throw new HttpError(
      409,
      "Authorize Gmail sending first. Your draft is saved.",
    );
  let reserved: Omit<ReservedSend, "application" | "account"> | undefined;
  changeFollowUp(
    services.store,
    application,
    request.expectedVersion,
    (record) => {
      assertNotBusy(services.store, record);
      const draft = record.draft;
      if (!draft || draft.id !== request.draftId)
        throw new HttpError(
          409,
          "The draft changed. Review the current text before sending.",
        );
      const to = request.testTo ?? draft.to;
      if (!isFollowUpAddress(to))
        throw new HttpError(
          400,
          "Enter the recipient's email address before sending.",
        );
      const sending = {
        id: randomUUID(),
        to,
        draftId: draft.id,
        test: request.testTo !== undefined,
        startedAt: now(),
      };
      reserved = { draft, sending };
      return { ...record, sending };
    },
  );
  return { ...reserved!, application, account: capability.account };
}

const releaseSend = (
  store: Store,
  reserved: ReservedSend,
  change: (record: ApplicationFollowUp) => ApplicationFollowUp,
  after?: (record: ApplicationFollowUp) => void,
) =>
  changeFollowUp(
    store,
    reserved.application,
    undefined,
    (record) =>
      record.sending?.id === reserved.sending.id ? change(record) : record,
    after,
  );

/** The full name confirmed in the saved application profile, when both parts are there. */
function profileName(store: Store) {
  try {
    const { profile } = readAutofillProfile(store);
    const [first, last] = [profile.firstName, profile.lastName].map((part) =>
      typeof part === "string" ? part.trim() : "",
    );
    return first && last ? `${first} ${last}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The From identity. Gmail's own compose window fills an empty send-as name
 * with the Google account name, but an API send keeps a bare address, so the
 * profile name stands in for it.
 */
async function senderIdentity(services: FollowUpSendServices) {
  const identity = await services.sender.identity().catch(() => undefined);
  return identity && !identity.name
    ? { ...identity, name: profileName(services.store) }
    : identity;
}

/** Hand the message to Gmail; anything other than a clear refusal leaves the send uncertain. */
async function transmit(
  services: FollowUpSendServices,
  reserved: ReservedSend,
) {
  try {
    const identity = await senderIdentity(services);
    return await services.sender.send(
      buildRawEmail({
        from: identity,
        to: reserved.sending.to,
        subject: reserved.draft.subject,
        body: reserved.draft.body,
      }),
    );
  } catch (error) {
    if (!(error instanceof GmailSendUncertain)) {
      releaseSend(services.store, reserved, (record) => ({
        ...record,
        sending: undefined,
      }));
      throw error;
    }
    releaseSend(services.store, reserved, (record) => ({
      ...record,
      sending: { ...reserved.sending, uncertain: true, error: error.message },
    }));
    throw new HttpError(502, error.message);
  }
}

export async function sendFollowUp(
  services: FollowUpSendServices,
  applicationId: string,
  request: FollowUpSendRequest,
) {
  const reserved = reserveSend(services, applicationId, request);
  const { draft, sending } = reserved;
  services.active.add(sending.id);
  services.changed();
  try {
    const result = await transmit(services, reserved);
    const verification = await verifySentCopy(services.sender, result.id, {
      to: sending.to,
      subject: draft.subject,
      body: draft.body,
    });
    const entry: SentFollowUpEmail = {
      id: sending.id,
      at: now(),
      to: sending.to,
      subject: draft.subject,
      body: draft.body,
      draftId: draft.id,
      verification,
      delivery: "gmail",
      account: reserved.account,
      gmailMessageId: result.id,
      gmailThreadId: result.threadId,
    };
    const record = releaseSend(
      services.store,
      reserved,
      (current) => ({
        ...current,
        sending: undefined,
        ...(sending.test
          ? {
              testSends: [entry, ...current.testSends].slice(
                0,
                followUpLimits.testSends,
              ),
            }
          : { sent: [...current.sent, entry] }),
      }),
      () => {
        if (!sending.test)
          services.store.journal(
            "follow_up_sent",
            `Follow-up email sent to ${sending.to}`,
            applicationId,
            { gmailMessageId: result.id, verification: verification.status },
          );
      },
    );
    return { record, sent: entry };
  } finally {
    services.active.delete(sending.id);
    services.changed();
  }
}

/** the user checked Gmail after an uncertain send and says whether it went out. */
export function resolveUncertainSend(
  store: Store,
  applicationId: string,
  expectedVersion: number,
  outcome: unknown,
) {
  if (outcome !== "sent" && outcome !== "not-sent")
    throw new HttpError(400, "Choose whether the email was sent.");
  const application = followUpApplication(store, applicationId);
  let reported: SentFollowUpEmail | undefined;
  return changeFollowUp(
    store,
    application,
    expectedVersion,
    (current) => {
      const sending = current.sending;
      if (!sending?.uncertain)
        throw new HttpError(409, "There is no uncertain send to resolve.");
      if (outcome === "not-sent" || sending.test)
        return { ...current, sending: undefined };
      const draft = [current.draft, ...current.history].find(
        (d) => d?.id === sending.draftId,
      );
      reported = {
        id: sending.id,
        at: sending.startedAt,
        to: sending.to,
        subject: draft?.subject ?? "",
        body: draft?.body ?? "",
        draftId: sending.draftId,
        delivery: "reported",
        verification: {
          status: "unverified",
          checkedAt: now(),
          detail: "You recorded this as sent after Gmail did not confirm it.",
        },
      };
      return {
        ...current,
        sending: undefined,
        sent: [...current.sent, reported],
      };
    },
    () => {
      if (reported)
        store.journal(
          "follow_up_sent",
          "Follow-up email recorded as sent after an unconfirmed send",
          applicationId,
        );
    },
  );
}

/** After a restart, a send that was in flight may or may not have reached Gmail. */
export function recoverInterruptedSends(store: Store) {
  for (const record of store.list("application_follow_up"))
    if (record.sending && !record.sending.uncertain)
      store.put("application_follow_up", record.id, {
        ...record,
        sending: {
          ...record.sending,
          uncertain: true,
          error:
            "Fieldwork restarted while this email was being sent. Check Gmail's Sent folder.",
        },
        version: record.version + 1,
        updatedAt: now(),
      });
}
