import type { ActivityEntry } from "./activity.js";
import type { DeletionKind } from "./record-deletion.js";

/**
 * Kinds the Saved records browser lists. Journal entries are shown only in the
 * Activity view, and saved filters are managed where they are used (Openings).
 */
export const catalogKinds = [
  "application",
  "application_autofill",
  "application_preparation",
  "career_scan",
  "company",
  "document",
  "greenhouse_pull_run",
  "opening",
  "opening_validation_run",
  "task",
] as const satisfies readonly DeletionKind[];
export type CatalogKind = (typeof catalogKinds)[number];

export const catalogSorts = ["newest", "oldest"] as const;
export type CatalogSort = (typeof catalogSorts)[number];

/** What a row's `at` timestamp means; never an employer publication date. */
export type CatalogTimeLabel = "Created" | "Started" | "Added" | "Updated";

/** A record the client can link to; the client builds the route from kind and id. */
export type RecordLink = { kind: string; id: string; title: string };

export type CatalogRow = {
  kind: CatalogKind;
  id: string;
  /** A human name (company and role, run date, file name); a bare id only when nothing better is stored. */
  title: string;
  /** Short context such as company · role, purpose or search scope. */
  subtitle?: string;
  status?: string;
  /** ISO timestamp. */
  at?: string;
  atLabel?: CatalogTimeLabel;
  /** Stored JSON size of the record itself; not files or reclaimable space. */
  bytes: number;
};

export type CatalogQuery = {
  kind?: CatalogKind;
  /** Case-insensitive match on title, subtitle, company, role and id. */
  q?: string;
  sort?: CatalogSort;
  cursor?: string;
  /** 1–100, default 50. */
  limit?: number;
};

export type CatalogPage = {
  rows: CatalogRow[];
  /** Rows matching every filter. */
  total: number;
  /** Rows per kind for the current search, ignoring the kind filter. */
  counts: Partial<Record<CatalogKind, number>>;
  nextCursor?: string;
};

export type RecordField = { label: string; value: string };

export type RecordDetail = {
  row: CatalogRow;
  /** Readable summary of the stored fields worth showing. */
  fields: RecordField[];
  /** Records this one points to or that point to it, found by exact id lookups. */
  related: RecordLink[];
  /** Counts every related record; `related` holds only the first 100. */
  relatedTotal: number;
  /** Newest journal entries about this record. */
  activity: ActivityEntry[];
  /** Pretty-printed stored JSON with heavy fields elided and long strings cut. */
  raw: string;
  rawTruncated: boolean;
};
