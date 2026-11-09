import type { Application, Document } from "../shared/types.js";

/** Build once for a state response; preserve application order and one usage
 * entry per application even when several packages contain the same document. */
export function applicationIndexes(applications: Application[]) {
  const byOpening = new Map<string, Application>();
  const documentUsage = new Map<
    string,
    NonNullable<Document["usedInApplications"]>
  >();
  for (const app of applications) {
    if (!byOpening.has(app.openingId)) byOpening.set(app.openingId, app);
    const ids = new Set(
      (app.packages ?? []).flatMap((pkg) =>
        (pkg.documents ?? []).map((doc) => doc.id),
      ),
    );
    for (const id of ids) {
      const usage = documentUsage.get(id) ?? [];
      usage.push({
        id: app.id,
        openingId: app.openingId,
        submittedAt: app.submittedAt,
      });
      documentUsage.set(id, usage);
    }
  }
  return { byOpening, documentUsage };
}
