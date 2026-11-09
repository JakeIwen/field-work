import type { RecordLink } from "./record-catalog.js";

export const activityLevels = ["info", "warning", "error"] as const;
export type ActivityLevel = (typeof activityLevels)[number];

/** A journal entry as the Activity view shows it. */
export type ActivityEntry = {
  id: string;
  /** ISO timestamp. */
  at: string;
  /** The stored journal type. */
  type: string;
  /** The workflow that wrote it, e.g. "Generate Docs", "Greenhouse autofill", "File import". */
  workflow: string;
  level: ActivityLevel;
  message: string;
  /** The record the entry is about, when it names one that still exists. */
  entity?: RecordLink;
  /** The stored details, pretty-printed and bounded. */
  details?: string;
  detailsTruncated?: boolean;
  /** When the entry was archived; archived entries leave the default view but stay in record history. */
  archivedAt?: string;
};

/** Which entries a query covers: "active" (the default) hides archived ones. */
export const activityArchiveScopes = ["active", "archived", "all"] as const;
export type ActivityArchiveScope = (typeof activityArchiveScopes)[number];

export type ActivityQuery = {
  /** Case-insensitive match on message, type, workflow and details. */
  q?: string;
  workflow?: string;
  /** Minimum severity: "warning" returns warnings and errors. */
  level?: ActivityLevel;
  /** Entries whose entityId, applicationId or recordId is any of these ids. */
  entity?: string[];
  archived?: ActivityArchiveScope;
  cursor?: string;
  /** 1–200, default 50. */
  limit?: number;
};

export type ActivityPage = {
  entries: ActivityEntry[];
  total: number;
  /** Counts for the current search, entity and archive scope, ignoring the workflow and level filters. */
  counts: {
    workflow: Record<string, number>;
    level: Record<ActivityLevel, number>;
  };
  nextCursor?: string;
};

/** Body of DELETE /api/journal: removes journal entries only, nothing they mention. */
export type JournalDeletionRequest = { ids: string[] };
export type JournalDeletionResult = { deleted: number; missing: number };
/** Most journal IDs one delete or archive request may name. */
export const journalDeletionMaxIds = 500;

/** Body of POST /api/journal/archive: `archived: false` restores entries. */
export type JournalArchiveRequest = { ids: string[]; archived: boolean };
export type JournalArchiveResult = { updated: number; missing: number };
