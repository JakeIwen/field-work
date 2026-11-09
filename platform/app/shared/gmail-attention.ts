import type { Application, ApplicationStatus } from "./types.js";
import { isNegativeReply, type EmployerReply } from "./gmail.js";

const closedStatuses: ReadonlySet<ApplicationStatus> = new Set([
  "rejected",
  "withdrawn",
]);

export function isEarlierEmployerReply(
  reply: EmployerReply,
  applications: Application[],
): boolean {
  if (isNegativeReply(reply.kind)) return false;
  const received = Date.parse(reply.receivedAt);
  if (!Number.isFinite(received) || !reply.applicationIds.length) return false;
  const byId = new Map(
    applications.map((application) => [application.id, application]),
  );
  return reply.applicationIds.every((id) => {
    const application = byId.get(id);
    if (!application) return false;
    const applied = Date.parse(
      application.submittedAt ?? application.createdAt,
    );
    if (Number.isFinite(applied) && received < applied) return true;
    const decision =
      application.employerReplyUpdate?.version === application.version
        ? application.employerReplyUpdate.receivedAt
        : application.updatedAt;
    return (
      closedStatuses.has(application.status) && received <= Date.parse(decision)
    );
  });
}
