import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store } from "../../server/storage.js";
import type { Records } from "../../server/records.js";
import {
  legacyApplication,
  legacyCompany,
  legacyDocument,
  legacyOpening,
  legacyTask,
} from "./legacy-records.js";

export const stateCacheRecords = {
  meta: {
    importedAt: "2026-10-29T00:00:00Z",
    companies: [],
    openings: [],
    documents: [],
    health: [],
    sourceHashes: { source: "before" },
    validSections: { companies: true, openings: true, documents: true },
    scan: {
      timestamp: null,
      seenCount: 2,
      failedCompanies: [],
      companyResults: [{ company_id: "custom-company", status: "scanned" }],
    },
  },
  cache_company: legacyCompany({
    id: "source-company",
    fields: {
      "Official site": "https://example.test",
      "Monitoring priority": "A",
    },
  }),
  custom_company: legacyCompany({
    id: "custom-company",
    scan: { result: "old", notes: "", sources: [] },
  }),
  cache_opening: legacyOpening({
    id: "opening",
    url: "https://job-boards.greenhouse.io/example/jobs/1",
    hash: "source-hash",
    sourceDate: "2026-10-29",
  }),
  custom_opening: legacyOpening({
    id: "custom-opening",
    url: "https://job-boards.greenhouse.io/example/jobs/1",
    sourceDate: "2026-10-28",
    company_id: "custom-company",
  }),
  opening_validation: {
    id: "custom-opening",
    url: "https://job-boards.greenhouse.io/example/jobs/1",
    status: "open",
    checkedAt: "2026-10-29",
    reason: "Live posting",
    evidenceHashes: [],
    runId: "validation",
  },
  cache_document: legacyDocument({
    id: "document",
    name: "Source document",
    text: 'Résumé "quoted"\n保留',
  }),
  generated_document: legacyDocument({
    id: "generated",
    name: "Generated document",
  }),
  personal: {
    id: "source-company",
    version: 1,
    pendingWatchlist: true,
    notes: "Personal notes",
  },
  application: legacyApplication({
    id: "application",
    openingId: "custom-opening",
    status: "applied",
    applicationDate: "2026-10-28",
    packages: [
      { id: "package", documents: [{ id: "document" }, { id: "document" }] },
    ],
  }),
  application_preparation: {
    id: "preparation",
    openingId: "custom-opening",
    applicationId: "application",
    status: "ready",
    phase: "ready",
    message: "Ready",
    createdAt: "2026-10-29",
    updatedAt: "2026-10-29",
    openingHash: "source-hash",
    documentIds: ["document", "generated"],
    taskIds: [],
    supportedForm: true,
  },
  task: legacyTask({
    id: "task",
    status: "completed",
    messages: [{ text: "Résumé 保留", role: "assistant" }],
    posting: {
      url: "https://example.test/job",
      text: "Full posting body",
      hash: "posting-hash",
      fetchedAt: "2026-10-29",
    },
    events: Array.from({ length: 502 }, (_, index) => ({
      method: "item/completed",
      params: { index },
    })),
  }),
  journal: {
    id: "journal",
    at: "2026-10-29",
    type: "fixture",
    message: "Journal entry",
  },
  filter: {
    id: "filter",
    name: "Saved filter",
    filters: { skill: ["React"] },
    createdAt: "2026-10-29",
  },
} satisfies Partial<Records>;

export function seedStateCache(store: Store) {
  for (const kind of Object.keys(
    stateCacheRecords,
  ) as (keyof typeof stateCacheRecords)[]) {
    const value = stateCacheRecords[kind];
    store.put(
      kind,
      kind === "meta" ? "import" : "id" in value ? value.id : "",
      value,
    );
  }
}

export function stateCacheFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-state-cache-"));
  const store = new Store(root, path.join(root, "data"));
  seedStateCache(store);
  return {
    root,
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
