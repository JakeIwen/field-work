import type { CompanyScan, ScanJob } from "./model.js";
import type { CareerScan } from "../records.js";

export type CareerCompanyResultPayload = Record<string, unknown> & {
  company_id?: unknown;
  result?: unknown;
};

export type CareerScanStatePayload = Record<string, unknown> & {
  seen_jobs?: unknown;
  company_results?: unknown;
  current_opening_keys?: unknown;
};

export type CareerScanBaselinePayload = {
  previous: unknown;
  openings: unknown[];
  history: string;
};

export type CareerScanManifestPayload = {
  phase: string;
  snapshot: string;
  files: { path: string; beforeHash: string; afterHash: string }[];
};

export type RecoverableCareerScan = CareerScan & {
  summary?: { failed?: number };
  completedAt?: string;
};

function isScanRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function scanRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isScanRecord(value)) throw Error(`Invalid ${name}`);
  return value;
}

function stringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

export function readCareerScanState(value: unknown): CareerScanStatePayload {
  return scanRecord(value, "careers scan state");
}

export function matchingCareerScanState(
  value: unknown,
  openingIds: string[],
): CareerScanStatePayload | undefined {
  if (!isScanRecord(value)) return undefined;
  const state = readCareerScanState(value);
  const keys = state.current_opening_keys;
  if (
    !state.seen_jobs ||
    Array.isArray(state.seen_jobs) ||
    !Array.isArray(state.company_results) ||
    !Array.isArray(keys) ||
    new Set(keys).size !== openingIds.length ||
    openingIds.some((id) => !keys.includes(id))
  )
    return undefined;
  return state;
}

export function isMissingCareerPath(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function readCareerCompanyResults(
  value: unknown,
): CareerCompanyResultPayload[] {
  const state = readCareerScanState(value);
  const rows = state.company_results || [];
  if (!Array.isArray(rows)) throw Error("Invalid careers company results");
  return rows.map((row) => scanRecord(row, "careers company result"));
}

export function failedCareerCompanyIds(
  value: unknown,
  active: Set<string>,
): string[] {
  return readCareerCompanyResults(value)
    .filter(
      (row) =>
        row.result !== "SUCCESS" &&
        typeof row.company_id === "string" &&
        active.has(row.company_id),
    )
    .map((row) => String(row.company_id));
}

export function readCareerScanBaseline(
  value: unknown,
): CareerScanBaselinePayload {
  const baseline = scanRecord(value, "careers scan baseline");
  if (!Array.isArray(baseline.openings) || typeof baseline.history !== "string")
    throw Error("Invalid careers scan baseline");
  return {
    previous: baseline.previous,
    openings: baseline.openings,
    history: baseline.history,
  };
}

function isScanJob(value: unknown): value is ScanJob {
  if (!isScanRecord(value)) return false;
  if (
    ![
      "id",
      "title",
      "url",
      "location",
      "description",
      "salary",
      "source",
      "at",
    ].every((key) => typeof value[key] === "string")
  )
    return false;
  return (
    (value.remote === undefined || typeof value.remote === "boolean") &&
    (value.listed === undefined || typeof value.listed === "boolean") &&
    (value.deadline === undefined ||
      value.deadline === null ||
      typeof value.deadline === "string") &&
    (value.detailUrl === undefined || typeof value.detailUrl === "string") &&
    (value.detailVerified === undefined ||
      typeof value.detailVerified === "boolean") &&
    (value.fingerprint === undefined || typeof value.fingerprint === "string")
  );
}

function isDirectCheck(value: unknown): boolean {
  if (!isScanRecord(value)) return false;
  return (
    ["open", "closed", "unknown"].includes(String(value.status)) &&
    typeof value.reason === "string" &&
    typeof value.at === "string" &&
    (value.job === undefined || isScanJob(value.job))
  );
}

function isCompanyScan(value: unknown): value is CompanyScan {
  if (!isScanRecord(value)) return false;
  if (
    typeof value.company_id !== "string" ||
    typeof value.company !== "string" ||
    !["SUCCESS", "PARTIAL", "FAILED"].includes(String(value.result)) ||
    (value.inventory_count !== null &&
      typeof value.inventory_count !== "number") ||
    typeof value.complete !== "boolean" ||
    !stringArray(value.sources) ||
    typeof value.notes !== "string" ||
    typeof value.checked_at !== "string" ||
    !Array.isArray(value.jobs) ||
    !value.jobs.every(isScanJob) ||
    !isScanRecord(value.direct)
  )
    return false;
  return Object.values(value.direct).every(isDirectCheck);
}

export function readCompanyScan(value: unknown): CompanyScan {
  if (!isCompanyScan(value)) throw Error("Saved company scan is invalid");
  return value;
}

export function readCareerScanManifest(
  value: unknown,
): CareerScanManifestPayload {
  const manifest = scanRecord(value, "careers scan manifest");
  if (
    typeof manifest.phase !== "string" ||
    typeof manifest.snapshot !== "string" ||
    !Array.isArray(manifest.files)
  )
    throw Error("Invalid careers scan manifest");
  const files = manifest.files.map((value) => {
    const file = scanRecord(value, "careers scan manifest file");
    if (
      typeof file.path !== "string" ||
      typeof file.beforeHash !== "string" ||
      typeof file.afterHash !== "string"
    )
      throw Error("Invalid careers scan manifest file");
    return {
      path: file.path,
      beforeHash: file.beforeHash,
      afterHash: file.afterHash,
    };
  });
  return {
    phase: manifest.phase,
    snapshot: manifest.snapshot,
    files,
  };
}

export function parseCareerScanBaseline(
  text: string,
): CareerScanBaselinePayload {
  const value: unknown = JSON.parse(text);
  return readCareerScanBaseline(value);
}

export function parseCompanyScan(text: string): CompanyScan {
  const value: unknown = JSON.parse(text);
  return readCompanyScan(value);
}

export function parseCareerScanManifest(
  text: string,
): CareerScanManifestPayload {
  const value: unknown = JSON.parse(text);
  return readCareerScanManifest(value);
}

export function completedRecoveredCareerScan(
  run: RecoverableCareerScan,
  completedAt: string,
): CareerScan {
  const recovered: RecoverableCareerScan = {
    ...run,
    status: run.summary?.failed ? "completed_with_gaps" : "completed",
    completedAt: run.completedAt || completedAt,
    error: null,
  };
  return recovered;
}
