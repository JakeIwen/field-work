import { tunables } from "../shared/tunables.js";
import { tunable, tunableMs } from "./tunables.js";
import { randomUUID } from "node:crypto";
import {
  followUpLimits,
  isFollowUpAddress,
  type ApplicationFollowUp,
  type ApplicationFollowUpSummary,
  type FollowUpDraft,
  type FollowUpGeneration,
  type FollowUpGenerationView,
  type FollowUpRecipientCandidate,
  type FollowUpRecipientSuggestion,
  type FollowUpTextFields,
} from "../shared/follow-up-email.js";
import type { EmployerReply } from "../shared/gmail.js";
import {
  isTaskBusy,
  type Application,
  type TaskStatus,
} from "../shared/types.js";
import type { Task } from "../shared/task-records.js";
import { HttpError, MissingRecordError, now, type Store } from "./storage.js";

const automatedSender =
  /(?:^|[._+-])(?:no-?reply|do-?not-?reply|notifications?|mailer-daemon|postmaster|bounces?)(?:[._+-]|@)/i;

export function followUpApplication(store: Store, applicationId: string) {
  const application = store.get("application", applicationId);
  if (!application)
    throw new MissingRecordError(
      404,
      "application",
      applicationId,
      "Application not found",
    );
  return application;
}

export function emptyFollowUp(application: Application): ApplicationFollowUp {
  const at = now();
  return {
    id: application.id,
    applicationId: application.id,
    openingId: application.openingId,
    version: 0,
    createdAt: at,
    updatedAt: at,
    history: [],
    sent: [],
    testSends: [],
  };
}

export const readFollowUp = (store: Store, applicationId: string) =>
  store.get("application_follow_up", applicationId);

/**
 * Apply a change under the record's version; the callback sees the current
 * record. `after` runs in the same transaction (journal entries commit with it).
 */
export function changeFollowUp(
  store: Store,
  application: Application,
  expectedVersion: number | undefined,
  change: (record: ApplicationFollowUp) => ApplicationFollowUp,
  after?: (record: ApplicationFollowUp) => void,
) {
  return store.transaction(() => {
    const current =
      readFollowUp(store, application.id) ?? emptyFollowUp(application);
    if (expectedVersion !== undefined && current.version !== expectedVersion)
      throw new HttpError(
        409,
        "This follow-up changed in another window or a revision arrived. Your unsaved text is still in the box; copy it, then reload.",
      );
    const next = change(current);
    if (next === current) return current;
    const saved = store.put("application_follow_up", application.id, {
      ...next,
      version: current.version + 1,
      updatedAt: now(),
    });
    after?.(saved);
    return saved;
  });
}

/** Replace the current draft; the previous one moves to history so nothing is lost. */
export function withDraft(
  record: ApplicationFollowUp,
  draft: Omit<FollowUpDraft, "id" | "at">,
): ApplicationFollowUp {
  const history = record.draft
    ? [record.draft, ...record.history].slice(0, followUpLimits.history)
    : record.history;
  return {
    ...record,
    history,
    draft: { ...draft, id: randomUUID(), at: now() },
  };
}

function boundedText(value: unknown, max: number, label: string) {
  if (typeof value !== "string" || value.length > max)
    throw new HttpError(
      400,
      `${label} must be text of at most ${max} characters.`,
    );
  return value;
}

export function followUpTextFields(body: unknown): FollowUpTextFields {
  const value = (body ?? {}) as Record<string, unknown>;
  const to = boundedText(
    value.to ?? "",
    followUpLimits.to,
    "The recipient",
  ).trim();
  const subject = boundedText(
    value.subject,
    followUpLimits.subject,
    "The subject",
  );
  const text = boundedText(value.body, followUpLimits.body, "The email");
  if (/[\r\n]/.test(subject))
    throw new HttpError(400, "Keep the subject on one line.");
  if (to && !isFollowUpAddress(to))
    throw new HttpError(
      400,
      "Enter one valid recipient email address, or leave it empty.",
    );
  return { to, subject, body: text.replace(/\r\n?/g, "\n") };
}

export const sameFollowUpText = (
  draft: FollowUpDraft | undefined,
  fields: FollowUpTextFields,
) =>
  !!draft &&
  draft.to === fields.to &&
  draft.subject === fields.subject &&
  draft.body === fields.body;

/** the user's saved edit; an unchanged save leaves the record alone. */
export function saveFollowUpEdit(
  store: Store,
  applicationId: string,
  expectedVersion: number,
  fields: FollowUpTextFields,
) {
  const application = followUpApplication(store, applicationId);
  return changeFollowUp(store, application, expectedVersion, (record) => {
    assertNotBusy(store, record);
    if (!record.draft)
      throw new HttpError(409, "Draft the follow-up email before editing it.");
    if (sameFollowUpText(record.draft, fields)) return record;
    return withDraft(record, { ...fields, source: "edited" });
  });
}

export function restoreFollowUpDraft(
  store: Store,
  applicationId: string,
  expectedVersion: number,
  draftId: string,
) {
  const application = followUpApplication(store, applicationId);
  return changeFollowUp(store, application, expectedVersion, (record) => {
    assertNotBusy(store, record);
    const earlier = record.history.find((draft) => draft.id === draftId);
    if (!earlier)
      throw new HttpError(404, "That earlier draft is no longer saved.");
    return withDraft(record, {
      to: record.draft?.to || earlier.to,
      subject: earlier.subject,
      body: earlier.body,
      source: "restored",
    });
  });
}

export function assertNotBusy(store: Store, record: ApplicationFollowUp) {
  if (generationView(store, record.generation)?.status === "drafting")
    throw new HttpError(
      409,
      "Wait for the current draft or revision to finish.",
    );
  if (record.sending)
    throw new HttpError(
      409,
      record.sending.uncertain
        ? "Resolve the earlier send first: check Gmail's Sent folder and record whether it went out."
        : "Wait for the current send to finish.",
    );
}

type TaskActivity = { status: TaskStatus; error: string | null };

function generationTask(store: Store, generation: FollowUpGeneration) {
  return store.db
    .prepare(
      `SELECT json_extract(json, '$.status') AS status, json_extract(json, '$.error') AS error
       FROM records WHERE kind='task' AND (id=? OR json_extract(json, '$.clientRequestId')=?) ORDER BY rowid DESC LIMIT 1`,
    )
    .get(generation.taskId ?? "", generation.requestId) as
    TaskActivity | undefined;
}

const stopped = (
  generation: FollowUpGeneration,
  error: string,
): FollowUpGenerationView => ({ ...generation, status: "failed", error });

/**
 * A request is active only during its grace period until the agent accepts it,
 * and afterwards only while its task is working; a restart can never leave it stuck.
 */
export function generationView(
  store: Store,
  generation: FollowUpGeneration | undefined,
): FollowUpGenerationView | undefined {
  if (!generation) return undefined;
  if (generation.status === "failed")
    return { ...generation, status: "failed" };
  if (generation.status === "requested")
    return Date.now() - Date.parse(generation.startedAt) <
      tunableMs(store, "followUp.graceMin")
      ? { ...generation, status: "drafting" }
      : stopped(generation, "The drafting request did not start.");
  const task = generationTask(store, generation);
  if (task && isTaskBusy(task.status))
    return { ...generation, status: "drafting" };
  return stopped(
    generation,
    task?.error ??
      (task?.status === "unavailable"
        ? "No agent is available right now."
        : "Drafting stopped before a draft was saved."),
  );
}

function addressesIn(text: string) {
  return [
    ...text.matchAll(
      /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    ),
  ]
    .map((match) => match[0].replace(/\.+$/, ""))
    .filter(isFollowUpAddress);
}

/** Employer replies per application, newest first, read once per projection. */
export function repliesByApplication(store: Store) {
  const grouped = new Map<string, EmployerReply[]>();
  const replies = store
    .list("employer_reply")
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  for (const reply of replies)
    for (const id of reply.applicationIds)
      grouped.set(id, [...(grouped.get(id) ?? []), reply]);
  return grouped;
}

/** Recipients from the user's own records: saved contacts, then people who replied about this application. */
export function recipientCandidates(
  application: Application,
  replies: EmployerReply[],
  limit: number = tunables["followUp.recipientCandidates"].default,
): FollowUpRecipientCandidate[] {
  const found = new Map<string, FollowUpRecipientCandidate>();
  for (const email of addressesIn(application.contacts ?? ""))
    found.set(email.toLowerCase(), { email, source: "application contacts" });
  for (const reply of replies) {
    const match = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(reply.sender);
    const email = (match?.[2] ?? reply.sender).trim();
    if (!isFollowUpAddress(email) || automatedSender.test(email)) continue;
    if (!found.has(email.toLowerCase()))
      found.set(email.toLowerCase(), {
        email,
        name: match?.[1]?.trim() || undefined,
        source: "employer reply",
      });
  }
  return [...found.values()].slice(0, limit);
}

export const applicationRecipients = (store: Store, application: Application) =>
  recipientCandidates(
    application,
    repliesByApplication(store).get(application.id) ?? [],
    tunable(store, "followUp.recipientCandidates"),
  );

export function followUpSummary(
  store: Store,
  record: ApplicationFollowUp,
  recipients: FollowUpRecipientCandidate[],
): ApplicationFollowUpSummary {
  const { history, generation, ...rest } = record;
  return {
    ...rest,
    historyCount: history.length,
    generation: generationView(store, generation),
    recipientCandidates: recipients,
  };
}

export function followUpSummaries(store: Store) {
  const applications = new Map(
    store
      .list("application")
      .map((application) => [application.id, application]),
  );
  const replies = repliesByApplication(store);
  return store.list("application_follow_up").flatMap((record) => {
    const application = applications.get(record.applicationId);
    return application
      ? [
          followUpSummary(
            store,
            record,
            recipientCandidates(
              application,
              replies.get(application.id) ?? [],
              tunable(store, "followUp.recipientCandidates"),
            ),
          ),
        ]
      : [];
  });
}

export function suggestionFrom(
  value: unknown,
): FollowUpRecipientSuggestion | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "recipient must be an object or null.");
  const raw = value as Record<string, unknown>;
  const email = typeof raw.email === "string" ? raw.email.trim() : "";
  const sourceUrl =
    typeof raw.sourceUrl === "string" ? raw.sourceUrl.trim() : "";
  if (!isFollowUpAddress(email))
    throw new HttpError(
      400,
      "recipient.email must be one plain email address.",
    );
  let url: URL;
  try {
    url = new URL(sourceUrl);
  } catch {
    throw new HttpError(
      400,
      "recipient.sourceUrl must be the public page that publishes the address.",
    );
  }
  if (!/^https?:$/.test(url.protocol))
    throw new HttpError(400, "recipient.sourceUrl must be an http(s) URL.");
  if (automatedSender.test(email))
    throw new HttpError(400, "Do not suggest a no-reply or automated address.");
  return {
    email,
    sourceUrl: url.href,
    name:
      typeof raw.name === "string" && raw.name.trim()
        ? raw.name.trim().slice(0, 120)
        : undefined,
    basis: typeof raw.basis === "string" ? raw.basis.trim().slice(0, 400) : "",
  };
}

function draftFromTool(args: unknown) {
  const value = (args ?? {}) as Record<string, unknown>;
  const subject = boundedText(
    value.subject,
    followUpLimits.subject,
    "subject",
  ).trim();
  const body = boundedText(value.body, followUpLimits.body, "body")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!subject || /[\r\n]/.test(subject))
    throw new HttpError(400, "subject must be one non-empty line.");
  if (body.split(/\s+/).length < 25)
    throw new HttpError(
      400,
      "body must be the complete email, including greeting and sign-off.",
    );
  return {
    subject,
    body,
    suggestion: suggestionFrom(value.recipient),
  };
}

const requestedBy = (generation: FollowUpGeneration | undefined, task: Task) =>
  !!generation &&
  generation.status !== "failed" &&
  (generation.taskId === task.id ||
    generation.requestId === task.clientRequestId);

/** Which request a save answers; the user may also ask for changes directly in the saved conversation. */
function savingRequest(current: ApplicationFollowUp, task: Task) {
  const generation = current.generation;
  if (generation && requestedBy(generation, task)) {
    if (
      generation.kind === "revise" &&
      generation.baseDraftId !== current.draft?.id
    )
      throw new HttpError(
        409,
        "the user's draft changed after this revision was requested; it was not replaced. Do not retry.",
      );
    return generation;
  }
  if (
    (generation && generation.status !== "failed") ||
    current.draftTaskId !== task.id
  )
    throw new HttpError(
      409,
      "This draft request is no longer current. The user started another draft or stopped this one; do not retry.",
    );
  return undefined;
}

/** Record the model's draft from the save tool while its request is current. */
export function stageFollowUpDraft(store: Store, task: Task, args: unknown) {
  const applicationId = task.context?.applicationId;
  if (task.preset !== "follow-up-email" || !applicationId)
    throw new HttpError(
      403,
      "This conversation does not draft follow-up emails.",
    );
  const application = followUpApplication(store, applicationId);
  const { subject, body, suggestion } = draftFromTool(args);
  const recipient = applicationRecipients(store, application)[0]?.email ?? "";
  changeFollowUp(
    store,
    application,
    undefined,
    (current) => {
      const generation = savingRequest(current, task);
      return {
        ...withDraft(current, {
          to: current.draft?.to || recipient,
          subject,
          body,
          source: generation?.kind === "generate" ? "generated" : "revised",
          taskId: task.id,
          turnId: task.activeTurnId ?? undefined,
          instruction: generation?.instruction,
        }),
        suggestion:
          suggestion ??
          (generation?.kind === "generate" ? undefined : current.suggestion),
        draftTaskId: task.id,
        generation: undefined,
      };
    },
    (saved) =>
      store.journal(
        "follow_up_drafted",
        "Follow-up email draft saved",
        applicationId,
        { taskId: task.id, draftId: saved.draft?.id },
      ),
  );
  store.autoExport();
  return {
    saved: true,
    message:
      "Draft saved for the user to review. Reply with one or two plain sentences about what the email emphasizes or what changed. Do not paste the email.",
  };
}

/** A turn that ends without saving leaves a clear, retryable failure instead of a stuck spinner. */
export function settleFollowUpTurn(
  store: Store,
  task: Task,
  succeeded: boolean,
) {
  const applicationId = task.context?.applicationId;
  if (task.preset !== "follow-up-email" || !applicationId) return false;
  const application = store.get("application", applicationId);
  const generation =
    application && readFollowUp(store, applicationId)?.generation;
  // A request not yet accepted may be waiting behind this (older) turn.
  if (
    !application ||
    generation?.status !== "drafting" ||
    !requestedBy(generation, task)
  )
    return false;
  const latest = store.get("task", task.id);
  changeFollowUp(store, application, undefined, (current) => ({
    ...current,
    generation: current.generation && {
      ...current.generation,
      status: "failed",
      error: succeeded
        ? "The model finished without saving a draft. Try again."
        : latest?.error || "The drafting turn stopped before saving a draft.",
    },
  }));
  return true;
}
