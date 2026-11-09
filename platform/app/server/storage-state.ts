import { tunables } from "../shared/tunables.js";
import { tunable } from "./tunables.js";
import type { AppState } from "../shared/types.js";
import { openingGenerationCounts } from "../shared/opening-documents.js";
import { applicationIndexes } from "./storage-application-index.js";
import { openingRecordKinds } from "./storage-openings.js";
import {
  cachedStateRead,
  stateTaskSummaries,
  withStateCache,
} from "./storage-state-cache.js";
import type { Store } from "./storage.js";

type StateMeta = Pick<
  AppState,
  "health" | "sourceHashes" | "scan" | "validSections" | "importedAt"
>;

function stateMeta(store: Store, personal: AppState["personal"]): StateMeta {
  return cachedStateRead(
    store,
    "meta",
    ["meta", "cache_company", "personal"],
    () => {
      const meta: StateMeta = store.get("meta", "import") ?? {
        health: [],
        sourceHashes: {},
        scan: { timestamp: null, seenCount: 0, failedCompanies: [] },
        validSections: {},
        importedAt: null,
      };
      const pending = store
        .list("cache_company")
        .filter((c) => personal[c.id]?.pendingWatchlist);
      return pending.length
        ? {
            ...meta,
            health: [
              ...meta.health,
              {
                id: "pending-watchlist",
                severity: "info",
                category: "watchlist",
                message: `${pending.length} new source employers await your explicit watchlist decision. In Companies, include unmonitored employers and choose Add to watchlist.`,
                paths: ["company_careers/companies.md"],
              },
            ],
          }
        : meta;
    },
  );
}

function stateCompanies(store: Store, meta: StateMeta) {
  return cachedStateRead(
    store,
    "companies",
    ["cache_company", "custom_company", "meta"],
    () =>
      [
        ...store.list("cache_company"),
        ...store.list("custom_company").map((c) => ({
          ...c,
          scan: Array.isArray(meta.scan.companyResults)
            ? (meta.scan.companyResults.find((r) => r.company_id === c.id) ??
              c.scan)
            : c.scan,
        })),
      ].map((company) => {
        // Keep historical JSON intact while omitting retired fields from API state.
        const record = { ...company } as typeof company & {
          priority?: unknown;
        };
        delete record.priority;
        const fields = { ...record.fields };
        delete fields["Monitoring priority"];
        return { ...record, fields };
      }),
  );
}

function stateDocuments(
  store: Store,
  personal: AppState["personal"],
  applications: AppState["applications"],
) {
  return cachedStateRead(
    store,
    "documents",
    ["cache_document", "generated_document", "personal", "application"],
    () => {
      const { documentUsage } = applicationIndexes(applications);
      return [
        ...store.list("cache_document"),
        ...store.list("generated_document"),
      ].map((d) => ({
        ...d,
        preferred: personal[d.id]?.preferred ?? false,
        usedInApplications: documentUsage.get(d.id) ?? [],
      }));
    },
  );
}

function stateOpenings(store: Store, applications: AppState["applications"]) {
  return cachedStateRead(
    store,
    "state-openings",
    [...openingRecordKinds, "application"],
    () => {
      const { byOpening } = applicationIndexes(applications);
      return store.openings().map((o) => {
        const application = byOpening.get(o.id);
        return {
          ...o,
          applicationDate: application?.applicationDate ?? null,
          applicationStartedAt: application?.startedAt ?? null,
          applicationStatus: application?.status ?? null,
        };
      });
    },
  );
}

function recentJournal(store: Store): AppState["journal"] {
  let limit: number = tunables["records.journalInState"].default;
  try {
    limit = tunable(store, "records.journalInState");
  } catch {
    /* Settings may not be readable during startup migrations. */
  }
  const rows = store.db
    .prepare(
      "SELECT json FROM records WHERE kind='journal' ORDER BY rowid DESC LIMIT ?",
    )
    .all(limit);
  return rows.map((row) => JSON.parse(String(row.json)));
}

/** Only record-derived pieces survive a request; settings still computes the
 * next scheduled runs from the current clock, and the route projects live data. */
export function readState(store: Store): AppState {
  return withStateCache(store, () => {
    const personal = cachedStateRead(store, "personal", ["personal"], () =>
      Object.fromEntries(store.list("personal").map((p) => [p.id, p])),
    );
    const meta = stateMeta(store, personal);
    const applications = cachedStateRead(
      store,
      "applications",
      ["application"],
      () => store.list("application"),
    );
    return {
      ...meta,
      companies: stateCompanies(store, meta),
      openings: stateOpenings(store, applications),
      documents: stateDocuments(store, personal, applications),
      openingGenerationCounts: cachedStateRead(
        store,
        "openingGenerationCounts",
        ["application_preparation"],
        () => openingGenerationCounts(store.list("application_preparation")),
      ),
      openingAutofillScriptIds: cachedStateRead(
        store,
        "openingAutofillScriptIds",
        ["application_autofill"],
        () =>
          Object.fromEntries(
            store.db
              .prepare(
                `SELECT id, json_extract(json, '$.openingId') AS openingId FROM records
          WHERE rowid IN (SELECT max(rowid) FROM records WHERE kind='application_autofill'
          GROUP BY json_extract(json, '$.openingId'))`,
              )
              .all()
              .map((row) => [String(row.openingId), String(row.id)]),
          ),
      ),
      personal,
      applications,
      tasks: stateTaskSummaries(store),
      journal: cachedStateRead(store, "journal", ["journal", "settings"], () =>
        recentJournal(store),
      ),
      settings: store.settings(),
      savedFilters: cachedStateRead(store, "savedFilters", ["filter"], () =>
        store.list("filter"),
      ),
    };
  });
}
