import type { AppState } from "../../shared/types.js";
import { applicationIndexes } from "../../server/storage-application-index.js";
import { openingGenerationCounts } from "../../shared/opening-documents.js";
import { readOpenings } from "../../server/storage-openings.js";
import type { Store } from "../../server/storage.js";

function latestScriptIds(store: Store) {
  return Object.fromEntries(
    store
      .list("application_autofill")
      .map((script) => [script.openingId, script.id]),
  );
}

// Frozen pre-cache projection: response-byte tests compare both implementations,
// including historical import metadata's property order and optional fields.
export function uncachedState(store: Store): AppState {
  const meta: Pick<
    AppState,
    "health" | "sourceHashes" | "scan" | "validSections" | "importedAt"
  > = store.get("meta", "import") ?? {
    health: [],
    sourceHashes: {},
    scan: { timestamp: null, seenCount: 0, failedCompanies: [] },
    validSections: {},
    importedAt: null,
  };
  const personal = Object.fromEntries(
    store.list("personal").map((p) => [p.id, p]),
  );
  const pendingCompanies = store
    .list("cache_company")
    .filter((c) => personal[c.id]?.pendingWatchlist);
  if (pendingCompanies.length)
    meta.health = [
      ...meta.health,
      {
        id: "pending-watchlist",
        severity: "info",
        category: "watchlist",
        message: `${pendingCompanies.length} new source employers await your explicit watchlist decision. In Companies, include unmonitored employers and choose Add to watchlist.`,
        paths: ["company_careers/companies.md"],
      },
    ];
  const applications = store.list("application");
  const { byOpening, documentUsage } = applicationIndexes(applications);
  const documents = [
    ...store.list("cache_document"),
    ...store.list("generated_document"),
  ].map((d) => ({
    ...d,
    preferred: personal[d.id]?.preferred ?? false,
    usedInApplications: documentUsage.get(d.id) ?? [],
  }));
  return {
    ...meta,
    companies: [
      ...store.list("cache_company"),
      ...store.list("custom_company").map((c) => ({
        ...c,
        scan: Array.isArray(meta.scan.companyResults)
          ? (meta.scan.companyResults.find((r) => r.company_id === c.id) ??
            c.scan)
          : c.scan,
      })),
    ].map((company) => {
      // Keep historical JSON intact while omitting the retired field from API state.
      const record = { ...company } as typeof company & {
        priority?: unknown;
      };
      delete record.priority;
      const fields = { ...record.fields };
      delete fields["Monitoring priority"];
      return { ...record, fields };
    }),
    openings: readOpenings(store).map((o) => {
      const application = byOpening.get(o.id);
      return {
        ...o,
        applicationDate: application?.applicationDate ?? null,
        applicationStartedAt: application?.startedAt ?? null,
        applicationStatus: application?.status ?? null,
      };
    }),
    documents,
    openingGenerationCounts: openingGenerationCounts(
      store.list("application_preparation"),
    ),
    openingAutofillScriptIds: latestScriptIds(store),
    personal,
    applications,
    tasks: store.taskSummaries(),
    journal: store.list("journal").slice(-400).reverse(),
    settings: store.settings(),
    savedFilters: store.list("filter"),
  };
}
