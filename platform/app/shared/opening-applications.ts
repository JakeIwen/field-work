import type { Application } from "./types";

export function appliedOpeningIds(
  applications: Pick<Application, "openingId" | "status" | "submittedAt">[],
): Set<string> {
  return new Set(
    applications
      .filter(
        (a) =>
          !!a.submittedAt ||
          ["applied", "interviewing", "offer"].includes(a.status),
      )
      .map((a) => a.openingId),
  );
}
