import { tunableValue, type TunableSettings } from "../../shared/tunables.js";
import type { Company, ImportResult } from "../../shared/types.js";
import { COMPANY_PATH } from "./parse-companies.js";
import { OPENINGS_PATH } from "./parse-openings.js";
import {
  errorMessage,
  issue,
  readSafe,
  type ReadContext,
} from "./read-context.js";

export const STATE_PATH = "company_careers/scan_state.json";

export type ScanCompanyResult = {
  company_id: string;
  result: string;
  [key: string]: unknown;
};

export type ScanState = {
  seen_jobs: Record<string, unknown>;
  company_results: ScanCompanyResult[];
  [key: string]: unknown;
};

function validateScanState(state: ScanState): void {
  if (
    !state.seen_jobs ||
    Array.isArray(state.seen_jobs) ||
    typeof state.seen_jobs !== "object" ||
    !Array.isArray(state.company_results)
  )
    throw new Error("Invalid scan state shape");
  if (
    state.company_results.some(
      (r) =>
        !r || typeof r.company_id !== "string" || typeof r.result !== "string",
    )
  )
    throw new Error("Incomplete company result in scan state");
  const scanCompanyIds = state.company_results.map((r) => r.company_id);
  if (new Set(scanCompanyIds).size !== scanCompanyIds.length)
    throw new Error("Duplicate company result in scan state");
  const activeCompanyIds = state.active_company_ids;
  if (
    Array.isArray(activeCompanyIds) &&
    (activeCompanyIds.length !== scanCompanyIds.length ||
      activeCompanyIds.some(
        // Compare unchecked pool entries verbatim, without adding string validation.
        (id: unknown) => !scanCompanyIds.includes(id as string),
      ))
  )
    throw new Error(
      "Scan results do not cover the recorded active company pool; preserve prior outcomes during this partial write",
    );
}

function applyScanStatus(
  ctx: ReadContext,
  result: ImportResult,
  state: ScanState,
  stateResults: Map<string, ScanCompanyResult>,
): void {
  result.scan.staleCompanies = state.company_results
    .filter((r) => {
      const checked =
        r.checked_at ||
        state.last_full_scan_completed ||
        state.last_scan_completed;
      // State metadata is intentionally unchecked; this assertion preserves Date.parse coercion.
      return (
        checked &&
        Date.now() - Date.parse(checked as string) >
          tunableValue(ctx.settings?.() ?? {}, "careers.staleDays") * 86400000
      );
    })
    .map((r) => r.company_id);
  if ((result.scan.staleCompanies as string[]).length)
    issue(
      ctx,
      "warning",
      "stale-company-scans",
      `${(result.scan.staleCompanies as string[]).length} employers have checks older than ${tunableValue(ctx.settings?.() ?? {}, "careers.staleDays") === 7 ? "seven" : tunableValue(ctx.settings?.() ?? {}, "careers.staleDays")} days; retrying other companies does not refresh them.`,
      [STATE_PATH],
    );
  result.scan.failedCompanies = state.company_results
    .filter((r) => r.result !== "SUCCESS")
    .map((r) => r.company_id);
  for (const failed of result.scan.failedCompanies)
    issue(
      ctx,
      "warning",
      "inaccessible-employer",
      `${stateResults.get(failed)?.company ?? failed}: the last company check was incomplete. See individual posting evidence; gaps do not establish closure.`,
      [STATE_PATH],
      stateResults.get(failed),
    );
}

function applyScanPoolChecks(
  ctx: ReadContext,
  result: ImportResult,
  state: ScanState,
): void {
  // Retain native Set behavior for unchecked metadata, including non-iterable errors.
  const stateCompanyIds = new Set(
    (state.active_company_ids ?? []) as Iterable<unknown>,
  );
  if (
    state.pool_selection !== "app monitored" &&
    result.validSections.companies &&
    (stateCompanyIds.size !== result.companies.length ||
      result.companies.some((c) => !stateCompanyIds.has(c.id)))
  )
    issue(
      ctx,
      "warning",
      "source-disagreement",
      "Watchlist membership differs from the recorded scan pool. The Markdown watchlist owns current membership; scan coverage is dated history.",
      [COMPANY_PATH, STATE_PATH],
      { scanDate: state.last_scan_completed },
    );
  // Retain native Set behavior for unchecked metadata, including non-iterable errors.
  const stateOpeningIds = new Set(
    (state.current_opening_keys ?? []) as Iterable<unknown>,
  );
  if (
    result.validSections.openings &&
    (stateOpeningIds.size !== result.openings.length ||
      result.openings.some((o) => !stateOpeningIds.has(o.id)))
  )
    issue(
      ctx,
      "warning",
      "source-disagreement",
      "Current openings differ from scan_state current_opening_keys. No closure was inferred from this disagreement.",
      [OPENINGS_PATH, STATE_PATH],
      { scanDate: state.last_scan_completed },
    );
}

function applyScanState(
  ctx: ReadContext,
  result: ImportResult,
  state: ScanState,
): void {
  // Only the scan-state timestamp's fallback behavior is preserved; its metadata is not validated.
  result.scan.timestamp =
    (state.last_scan_completed as string | null | undefined) ?? null;
  result.scan.seenCount = Object.keys(state.seen_jobs).length;
  result.scan.baseline = state.baseline === true;
  result.scan.lastFullScan =
    state.last_full_scan_completed ?? state.last_scan_completed;
  result.scan.lastScanSummary = state.last_scan_summary ?? null;
  result.scan.companyResults = state.company_results;
  result.scan.comparisonNotes = state.comparison_notes;
  result.scan.stateValid = true;
  const stateResults = new Map<string, ScanCompanyResult>(
    state.company_results.map((r) => [r.company_id, r]),
  );
  for (const company of result.companies)
    // Validation checks only company_id/result; preserve unchecked notes/sources.
    company.scan = (stateResults.get(company.id) ?? {
      result: "UNKNOWN",
      notes: "No scan result found for this monitored employer.",
      sources: [],
    }) as NonNullable<Company["scan"]>;
  applyScanStatus(ctx, result, state, stateResults);
  applyScanPoolChecks(ctx, result, state);
}

export async function readScanState(
  ctx: ReadContext,
  result: ImportResult,
): Promise<ScanState | null> {
  let state: ScanState | null = null;
  try {
    // JSON payloads are validated only by the exact checks below; retain all other fields.
    state = JSON.parse(
      (await readSafe(ctx, STATE_PATH)).toString("utf8"),
    ) as ScanState;
    validateScanState(state);
    applyScanState(ctx, result, state);
    return state;
  } catch (error) {
    state = null;
    result.scan.stateValid = false;
    issue(
      ctx,
      "error",
      "invalid-scan-state",
      `Seen-job and scan status could not be read: ${errorMessage(error)}. Preserve previously imported scan history.`,
      [STATE_PATH],
    );
    return state;
  }
}
