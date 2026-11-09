import type { EmployerReply } from "../../shared/gmail.js";
import type { Application, ApplicationStatus } from "../../shared/types.js";
import { now, type Store } from "../storage.js";

function predatesApplicationChange(
  reply: EmployerReply,
  application: Application,
) {
  const received = Date.parse(reply.receivedAt);
  const lastChange =
    application.employerReplyUpdate?.version === application.version
      ? application.employerReplyUpdate.receivedAt
      : application.updatedAt;
  const newest = Math.max(
    Date.parse(application.createdAt),
    Date.parse(lastChange),
    Date.parse(application.submittedAt ?? application.createdAt),
  );
  return (
    !Number.isFinite(received) || !Number.isFinite(newest) || received < newest
  );
}

export function applyEmployerReply(
  store: Store,
  reply: EmployerReply,
  application: Application,
) {
  if (!["applied", "interviewing", "offer"].includes(application.status)) {
    reply.reason += " Application stage requires manual review.";
    return;
  }
  if (predatesApplicationChange(reply, application)) {
    reply.reason +=
      " This email predates the latest application change; no automatic update.";
    return;
  }
  // Offers and unclear negative outcomes need an explicit manual decision.
  if (
    application.status === "offer" ||
    reply.kind === "negative" ||
    reply.kind === "follow_up"
  )
    return;
  const target: ApplicationStatus =
    reply.kind === "rejection"
      ? "rejected"
      : reply.kind === "offer"
        ? "offer"
        : reply.kind === "interview"
          ? "interviewing"
          : application.status;
  const action =
    reply.kind === "rejection"
      ? ""
      : reply.kind === "assessment"
        ? "Complete employer assessment (see Gmail reply)"
        : reply.kind === "interview"
          ? "Respond to interview invitation"
          : "Review employer offer";
  // Replace only an action this integration still owns; preserve manual work.
  const ownsAction =
    application.employerReplyUpdate?.version === application.version &&
    application.employerReplyUpdate.nextAction === application.nextAction;
  if (target === application.status && application.nextAction && !ownsAction)
    return;
  const nextAction =
    !application.nextAction || ownsAction ? action : application.nextAction;
  const at = now();
  store.put("application", application.id, {
    ...application,
    status: target,
    nextAction,
    version: application.version + 1,
    updatedAt: at,
    employerReplyUpdate: {
      replyId: reply.id,
      receivedAt: reply.receivedAt,
      version: application.version + 1,
      nextAction: nextAction === action ? action : undefined,
    },
  });
  reply.update = {
    applicationId: application.id,
    from: application.status,
    to: target,
    at,
  };
  store.journal(
    "gmail_application_updated",
    `Employer reply: ${reply.kind}`,
    application.id,
    { replyId: reply.id, from: application.status, to: target },
  );
}

export function settlePendingRejections(
  store: Store,
  account: string,
  autoUpdate: boolean,
) {
  const replies = store
    .list("employer_reply")
    .filter((reply) => reply.account === account);
  for (const reply of replies.filter((item) => item.pendingApplicationId)) {
    store.transaction(() => {
      const applicationId = reply.pendingApplicationId!;
      const application = store.get("application", applicationId);
      const newer = replies.some(
        (other) =>
          other.id !== reply.id &&
          other.applicationIds.includes(applicationId) &&
          other.receivedAt >= reply.receivedAt,
      );
      if (newer)
        reply.reason +=
          " A newer or simultaneous employer reply also matches this application; review before rejecting it.";
      else if (autoUpdate && application)
        applyEmployerReply(store, reply, application);
      delete reply.pendingApplicationId;
      store.put("employer_reply", reply.id, reply);
    });
  }
}
