import { readTaskEvents } from "./storage-task-events.js";
import { now, type Store } from "./storage.js";
import type { TaskEvent } from "../shared/task-records.js";
import type { Records } from "./records.js";

// Literal registry keys preserve each exported list type instead of widening to string.
export const personalExportKinds = [
  "deleted_record",
  "personal",
  "custom_company",
  "custom_opening",
  "company_contact",
  "application",
  "task",
  "journal",
  "settings",
  "filter",
  "bundle",
  "reference_context",
  "generated_document",
  "application_autofill",
  "application_preparation",
  "application_answer_set",
  "application_answer_review",
  "application_follow_up",
  "career_scan",
  "opening_form_check",
  "opening_validation",
  "opening_validation_run",
  "greenhouse_pull_run",
  "greenhouse_pull_candidate",
  "greenhouse_guidance_history",
  "greenhouse_review_memory",
  "employer_reply",
  "gmail_preferences",
  "gmail_scan",
] as const;

export function personalExportMetadata() {
  return { schemaVersion: 1, exportedAt: now() };
}

type ExportKind = (typeof personalExportKinds)[number];
type ExportRecord<K extends ExportKind> = K extends "task"
  ? Records[K] & { events: TaskEvent[] }
  : Records[K];

/** Reattach one task's events at a time, using its storage key rather than an optional legacy payload ID. */
export function* personalExportRows<K extends ExportKind>(
  store: Pick<Store, "db">,
  kind: K,
): Generator<ExportRecord<K>> {
  const rows = store.db.prepare(
    "SELECT id,json FROM records WHERE kind=? ORDER BY rowid",
  );
  for (const row of rows.iterate(kind)) {
    if (typeof row.json !== "string") throw Error("Invalid export record JSON");
    const value = JSON.parse(row.json);
    if (kind === "task")
      value.events = readTaskEvents(store.db, String(row.id));
    yield value;
  }
}

export function personalExportSnapshot(store: Pick<Store, "db">) {
  return {
    ...personalExportMetadata(),
    // Each tuple key is paired with its registry-specific list; Object.fromEntries loses that relationship.
    records: Object.fromEntries(
      personalExportKinds.map((k) => [k, [...personalExportRows(store, k)]]),
    ) as {
      [K in ExportKind]: ExportRecord<K>[];
    },
  };
}
