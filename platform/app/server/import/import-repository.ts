import { tunableValue, type TunableSettings } from "../../shared/tunables.js";
import { realpath } from "node:fs/promises";
import path from "node:path";

import type { ImportResult, Opening } from "../../shared/types.js";
import { sha256 } from "../storage.js";
import { SOURCE_README } from "./classify-documents.js";
import { importDocuments } from "./import-documents.js";
import { COMPANY_PATH, parseCompanies } from "./parse-companies.js";
import {
  OPENING_FIELDS,
  OPENINGS_PATH,
  parseOpenings,
} from "./parse-openings.js";
import {
  errorMessage,
  issue,
  readSafe,
  textOptional,
  walk,
  type ReadContext,
} from "./read-context.js";
import { readScanState, STATE_PATH, type ScanState } from "./scan-state.js";

import { norm } from "./text.js";

// Legacy scan metadata is cast only at consumers; scan-state validation leaves it unchecked.
type LegacyScanSeenJob = {
  first_seen?: unknown;
  last_seen?: unknown;
  last_confirmed_listed?: unknown;
  qualification?: unknown;
};
type LegacyArchivedOpening = {
  company_id?: unknown;
  job_id?: unknown;
  title?: unknown;
  url?: unknown;
  postingStatus?: unknown;
  closedAt?: unknown;
  [key: string]: unknown;
};
type SnapshotSummary = {
  path: string;
  timestamp: string | null;
  count: number;
  valid: boolean;
};
type LatestSnapshot = { path: string; data: any };
type SnapshotOpening = LatestSnapshot["data"]["openings"][number];

async function readCompanies(
  ctx: ReadContext,
  result: ImportResult,
): Promise<void> {
  try {
    const content = (await readSafe(ctx, COMPANY_PATH)).toString("utf8");
    result.companies = parseCompanies(content);
    result.validSections.companies = true;
  } catch (error) {
    issue(
      ctx,
      "error",
      "invalid-import",
      `Preserving prior companies: ${errorMessage(error)}`,
      [COMPANY_PATH],
    );
  }
}

async function readOpenings(
  ctx: ReadContext,
  result: ImportResult,
): Promise<void> {
  try {
    const content = (await readSafe(ctx, OPENINGS_PATH)).toString("utf8");
    result.openings = parseOpenings(content);
    result.validSections.openings = true;
  } catch (error) {
    issue(
      ctx,
      "error",
      "invalid-import",
      `Preserving prior openings: ${errorMessage(error)}`,
      [OPENINGS_PATH],
    );
  }
}

async function importResearch(
  ctx: ReadContext,
  result: ImportResult,
): Promise<void> {
  ctx.onProgress?.({ phase: "research" });
  await readCompanies(ctx, result);
  await readOpenings(ctx, result);
}

async function importDocumentSources(
  ctx: ReadContext,
  result: ImportResult,
): Promise<void> {
  const sourceReadme = await textOptional(ctx, SOURCE_README);
  const importedDocs = await importDocuments(ctx, sourceReadme);
  result.documents = importedDocs.documents;
  result.validSections.documents = importedDocs.valid;
}

async function importHistory(
  ctx: ReadContext,
  result: ImportResult,
): Promise<ScanState | null> {
  ctx.onProgress?.({ phase: "history" });
  await textOptional(ctx, "source_data/github_evidence_dossier.md");
  const history = await textOptional(ctx, "company_careers/scan_history.md");
  result.scan.history = history;
  return readScanState(ctx, result);
}

async function discoverSnapshotPaths(ctx: ReadContext): Promise<string[]> {
  return (
    await walk(ctx, "company_careers/research/scans").catch((error) => {
      issue(ctx, "warning", "scan-evidence", errorMessage(error), [
        "company_careers/research/scans",
      ]);
      return [];
    })
  )
    .filter((p) => p.endsWith("/qualified_openings.json"))
    .sort()
    .reverse();
}

async function readSnapshots(
  ctx: ReadContext,
  snapshotPaths: string[],
): Promise<{
  snapshots: SnapshotSummary[];
  latest: LatestSnapshot | null;
}> {
  const snapshots: SnapshotSummary[] = [];
  let latest: LatestSnapshot | null = null;
  let snapshotsCompleted = 0;
  ctx.onProgress?.({
    phase: "snapshots",
    completed: 0,
    total: snapshotPaths.length,
  });
  for (const snapshotPath of snapshotPaths) {
    try {
      const data = JSON.parse(
        (await readSafe(ctx, snapshotPath)).toString("utf8"),
      );
      if (
        !Array.isArray(data.openings) ||
        data.openings.some(
          (o: SnapshotOpening) => !o.company_id || !o.job_id || !o.title,
        )
      )
        throw new Error(
          "Snapshot requires an openings array with company/requisition IDs and titles",
        );
      if (
        new Set(
          data.openings.map(
            (o: SnapshotOpening) => `${o.company_id}:${o.job_id}`,
          ),
        ).size !== data.openings.length
      )
        throw new Error("Duplicate identities in snapshot");
      snapshots.push({
        path: snapshotPath,
        timestamp: data.scan_timestamp ?? null,
        count: data.openings.length,
        valid: true,
      });
      if (
        !latest ||
        Date.parse(data.scan_timestamp ?? "") >
          Date.parse(latest.data.scan_timestamp ?? "")
      )
        latest = { path: snapshotPath, data };
    } catch (error) {
      snapshots.push({
        path: snapshotPath,
        timestamp: null,
        count: 0,
        valid: false,
      });
      issue(
        ctx,
        "error",
        "invalid-snapshot",
        `Snapshot import failed: ${errorMessage(error)}`,
        [snapshotPath],
      );
    } finally {
      ctx.onProgress?.({
        phase: "snapshots",
        completed: ++snapshotsCompleted,
        total: snapshotPaths.length,
      });
    }
  }
  return { snapshots, latest };
}

function compareOpeningWithLatest(
  ctx: ReadContext,
  opening: Opening,
  latest: LatestSnapshot,
  byId: Map<string, SnapshotOpening>,
  compared: readonly (keyof Opening)[],
  state: ScanState | null,
): void {
  const snapshot = byId.get(opening.id);
  const differences = snapshot
    ? compared
        .filter((field) => norm(opening[field]) !== norm(snapshot[field]))
        .map((field) => ({
          field,
          current: opening[field],
          snapshot: snapshot[field],
        }))
    : [{ field: "membership", current: "present", snapshot: "absent" }];
  opening.snapshotPath = latest.path;
  if (differences.length) {
    opening.discrepancy = [
      {
        sourceDate: opening.sourceDate,
        snapshotDate: latest.data.scan_timestamp,
        sourcePath: OPENINGS_PATH,
        snapshotPath: latest.path,
        differences,
      },
    ];
    issue(
      ctx,
      "warning",
      "source-disagreement",
      `${opening.company} / ${opening.title}: current Markdown and dated snapshot disagree.`,
      [OPENINGS_PATH, latest.path],
      opening.discrepancy,
    );
  }
  // State metadata is intentionally unchecked; this cast preserves old property access/coercion.
  const seen = (
    state?.seen_jobs as Record<string, LegacyScanSeenJob> | undefined
  )?.[opening.id];
  if (seen)
    // Preserve unchecked history values at the existing Opening type boundary.
    opening.identityHistory = {
      firstSeen: seen.first_seen ?? null,
      lastSeen: seen.last_seen ?? null,
      lastConfirmedListed: seen.last_confirmed_listed ?? null,
      qualification: seen.qualification,
    } as NonNullable<Opening["identityHistory"]>;
}

function compareLatestSnapshot(
  ctx: ReadContext,
  result: ImportResult,
  state: ScanState | null,
  latest: LatestSnapshot,
): Map<string, SnapshotOpening> {
  const byId = new Map<string, SnapshotOpening>(
    latest.data.openings.map((o: SnapshotOpening) => [
      `${o.company_id}:${o.job_id}`,
      o,
    ]),
  );
  const compared = [
    "title",
    "company",
    "url",
    ...Object.values(OPENING_FIELDS),
    "first_seen",
    "last_confirmed_open",
  ];
  for (const opening of result.openings)
    compareOpeningWithLatest(ctx, opening, latest, byId, compared, state);
  for (const [id, opening] of byId)
    if (
      !result.openings.some((o) => o.id === id) &&
      result.validSections.openings
    )
      issue(
        ctx,
        "warning",
        "source-disagreement",
        `${opening.company} / ${opening.title} is in the dated snapshot but absent from current Markdown. Absence alone does not establish closure.`,
        [OPENINGS_PATH, latest.path],
        { id, snapshotDate: latest.data.scan_timestamp },
      );
  return byId;
}

async function readLatestCoverage(
  ctx: ReadContext,
  result: ImportResult,
  state: ScanState | null,
  latest: LatestSnapshot,
  dir: string,
): Promise<void> {
  try {
    const coverage = JSON.parse(
      (await readSafe(ctx, `${dir}/company_results.json`)).toString("utf8"),
    );
    if (!Array.isArray(coverage))
      throw new Error("Company results must be an array");
    result.scan.companyResultsPath = `${dir}/company_results.json`;
    if (
      state &&
      norm(JSON.stringify(coverage)) !==
        norm(JSON.stringify(state.company_results))
    )
      issue(
        ctx,
        "warning",
        "source-disagreement",
        "Dated company_results and scan_state company results disagree; inspect both source dates.",
        [`${dir}/company_results.json`, STATE_PATH],
        {
          snapshotDate: latest.data.scan_timestamp,
          stateDate: state.last_scan_completed,
        },
      );
  } catch (error) {
    issue(
      ctx,
      "warning",
      "scan-evidence",
      `Company coverage unavailable: ${errorMessage(error)}`,
      [`${dir}/company_results.json`],
    );
  }
}

async function readLatestDescriptions(
  ctx: ReadContext,
  result: ImportResult,
  byId: Map<string, SnapshotOpening>,
  dir: string,
): Promise<void> {
  try {
    const descriptions = JSON.parse(
      (await readSafe(ctx, `${dir}/selected-source-jobs.json`)).toString(
        "utf8",
      ),
    );
    if (!Array.isArray(descriptions))
      throw new Error("Selected posting descriptions must be an array");
    for (const opening of result.openings) {
      const source = descriptions.find(
        (d) =>
          d.company_id === opening.company_id &&
          (String(d.id) === opening.job_id ||
            String(d.id) === byId.get(opening.id)?.source_key ||
            d.url === opening.url),
      );
      if (source) {
        opening.description =
          typeof source.description === "string" ? source.description : "";
        opening.descriptionSourcePath = `${dir}/selected-source-jobs.json`;
        opening.descriptionConfirmedAt =
          source.confirmed_at ?? source.at ?? null;
        opening.publishedCompensation =
          source.compensation ?? source.salary ?? null;
      }
    }
  } catch (error) {
    issue(
      ctx,
      "warning",
      "scan-evidence",
      `Posting descriptions unavailable: ${errorMessage(error)}`,
      [`${dir}/selected-source-jobs.json`],
    );
  }
}

async function readLatestEvidence(
  ctx: ReadContext,
  result: ImportResult,
  state: ScanState | null,
  latest: LatestSnapshot,
  byId: Map<string, SnapshotOpening>,
): Promise<void> {
  const dir = path.posix.dirname(latest.path);
  result.scan.sourceDescriptionPath = `${dir}/README.md`;
  result.scan.sourceDescription = await textOptional(ctx, `${dir}/README.md`);
  await readLatestCoverage(ctx, result, state, latest, dir);
  await readLatestDescriptions(ctx, result, byId, dir);
}

async function readHistoricalDescriptions(
  ctx: ReadContext,
  result: ImportResult,
  snapshots: SnapshotSummary[],
  latest: LatestSnapshot | null,
): Promise<void> {
  // Partial retries do not erase earlier posting evidence. Keep its actual source date/path.
  for (const snapshot of snapshots
    .filter((s) => s.valid)
    .sort(
      (a, b) => Date.parse(b.timestamp || "") - Date.parse(a.timestamp || ""),
    )) {
    if (!result.openings.some((o) => !o.description)) break;
    const sourcePath =
      path.posix.dirname(snapshot.path) + "/selected-source-jobs.json";
    if (
      latest &&
      sourcePath ===
        path.posix.dirname(latest.path) + "/selected-source-jobs.json"
    )
      continue;
    try {
      const older = JSON.parse(
        (await readSafe(ctx, sourcePath)).toString("utf8"),
      );
      if (!Array.isArray(older)) continue;
      const qualified = JSON.parse(
        (await readSafe(ctx, snapshot.path)).toString("utf8"),
      ).openings;
      for (const opening of result.openings.filter((o) => !o.description)) {
        const alias = qualified.find(
          (q: SnapshotOpening) =>
            q.company_id === opening.company_id && q.job_id === opening.job_id,
        )?.source_key;
        const source = older.find(
          (d: SnapshotOpening) =>
            d.company_id === opening.company_id &&
            (String(d.id) === opening.job_id ||
              String(d.id) === alias ||
              d.url === opening.url),
        );
        if (
          typeof source?.description !== "string" ||
          !source.description.trim()
        )
          continue;
        opening.description = source.description;
        opening.descriptionSourcePath = sourcePath;
        opening.descriptionConfirmedAt =
          source.confirmed_at ?? source.at ?? null;
        opening.publishedCompensation =
          source.compensation ?? source.salary ?? null;
      }
    } catch {
      /* Missing historical detail remains unknown; current import validity is unchanged. */
    }
  }
}

function appendArchivedOpenings(
  result: ImportResult,
  state: ScanState | null,
): void {
  // Archived opening metadata is retained verbatim; only the old presence/status guards remain.
  const archivedOpenings = Array.isArray(state?.archived_openings)
    ? (state.archived_openings as LegacyArchivedOpening[])
    : null;
  if (archivedOpenings) {
    for (const old of archivedOpenings) {
      if (
        !old?.company_id ||
        !old?.job_id ||
        !old?.title ||
        !old?.url ||
        old.postingStatus !== "closed"
      )
        continue;
      const id = `${old.company_id}:${old.job_id}`;
      if (result.openings.some((o) => o.id === id)) continue;
      // The legacy record is intentionally not validated beyond the original guards.
      result.openings.push({
        ...old,
        id,
        retained: false,
        postingStatus: "closed",
        sourcePath: STATE_PATH,
        sourceDate: old.closedAt || null,
        hash: sha256(JSON.stringify(old)),
      } as (typeof result.openings)[number]);
    }
  }
}

function checkStaleScan(ctx: ReadContext, result: ImportResult): void {
  if (
    result.scan.timestamp &&
    Date.now() - Date.parse(result.scan.timestamp) >
      tunableValue(ctx.settings?.() ?? {}, "careers.staleDays") * 86400000
  )
    issue(
      ctx,
      "warning",
      "stale-scan",
      `The last careers scan is over ${tunableValue(ctx.settings?.() ?? {}, "careers.staleDays") === 7 ? "seven" : tunableValue(ctx.settings?.() ?? {}, "careers.staleDays")} days old. Reindexing files does not refresh live vacancy status.`,
      [STATE_PATH],
      { lastScan: result.scan.timestamp },
    );
}

function reconcileOpeningStatuses(
  ctx: ReadContext,
  result: ImportResult,
  state: ScanState | null,
): void {
  for (const opening of result.openings) {
    if (
      !result.companies.some((c) => c.id === opening.company_id) &&
      !(
        Array.isArray(state?.app_custom_company_ids) &&
        state.app_custom_company_ids.includes(opening.company_id)
      )
    )
      issue(
        ctx,
        "warning",
        "unknown-company",
        `Opening refers to a company absent from the current watchlist: ${opening.company_id}`,
        [OPENINGS_PATH, COMPANY_PATH],
      );
    if (
      result.scan.failedCompanies.includes(opening.company_id) &&
      !opening.lastCheckedAt &&
      opening.postingStatus !== "closed"
    )
      opening.postingStatus = "not confirmed open";
  }
}

export async function importRepository(
  root: string,
  onProgress?: ReadContext["onProgress"],
  settings?: () => TunableSettings,
): Promise<ImportResult> {
  const ctx: ReadContext = {
    root: await realpath(root),
    sourceHashes: {},
    health: [],
    onProgress,
    settings,
  };
  const result: ImportResult = {
    companies: [],
    openings: [],
    documents: [],
    health: ctx.health,
    scan: { timestamp: null, seenCount: 0, failedCompanies: [] },
    sourceHashes: ctx.sourceHashes,
    validSections: { companies: false, openings: false, documents: false },
    importedAt: new Date().toISOString(),
  };
  await importResearch(ctx, result);
  await importDocumentSources(ctx, result);
  const state = await importHistory(ctx, result);
  const snapshotPaths = await discoverSnapshotPaths(ctx);
  const { snapshots, latest } = await readSnapshots(ctx, snapshotPaths);
  ctx.onProgress?.({ phase: "reconcile" });
  result.scan.snapshots = snapshots;
  if (latest) {
    const byId = compareLatestSnapshot(ctx, result, state, latest);
    await readLatestEvidence(ctx, result, state, latest, byId);
  }
  await readHistoricalDescriptions(ctx, result, snapshots, latest);
  appendArchivedOpenings(result, state);
  checkStaleScan(ctx, result);
  reconcileOpeningStatuses(ctx, result, state);
  return result;
}
