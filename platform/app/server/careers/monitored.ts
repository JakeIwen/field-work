import type { reconcileScan } from "./reconcile.js";
import { collectCompany, type CompanyScan } from "./providers.js";
import type { Store } from "../storage.js";

export function monitoredCompanies(store: Store) {
  const personal = new Map(
    store.list("personal").map((record) => [record.id, record]),
  );
  return [
    ...store.list("cache_company"),
    ...store.list("custom_company"),
  ].filter(
    (company) =>
      !company.sourceMissing && personal.get(company.id)?.monitoring !== false,
  );
}

/** Limit individual rechecks, not the source history supplied to reconciliation. */
export function scanCompanyOpenings(
  store: Store,
  companyId: string,
  base: Pick<Parameters<typeof reconcileScan>[0], "openings" | "previous">,
) {
  return [...base.openings, ...(base.previous.archived_openings || [])].filter(
    (opening) =>
      opening.company_id === companyId &&
      !store.get(
        "personal",
        opening.id ?? `${opening.company_id}:${opening.job_id}`,
      )?.dismissed,
  );
}

export function collectMonitoredCompany(
  store: Store,
  company: Parameters<typeof collectCompany>[0],
  base: Pick<Parameters<typeof reconcileScan>[0], "openings" | "previous">,
  get: Parameters<typeof collectCompany>[3],
  signal: AbortSignal,
  browserGet: Parameters<typeof collectCompany>[5],
) {
  return collectCompany(
    company,
    base.previous.company_results.find(
      (r: Pick<CompanyScan, "company_id">) => r.company_id === company.id,
    ),
    scanCompanyOpenings(store, company.id, base),
    get,
    signal,
    browserGet,
    { settings: () => store.settings() },
  );
}
