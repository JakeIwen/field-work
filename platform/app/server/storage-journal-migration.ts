import type { JournalEntry } from "../shared/task-records.js";
import { now, type Store } from "./storage.js";

export const journalPruningMigrationVersion = 9;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Match only the retired messages; a shared type can still hold actionable history. */
export function isRoutineJournalEntry(entry: JournalEntry): boolean {
  const details = record(entry.details);
  switch (entry.type) {
    case "task_created":
      return / task prepared$/.test(entry.message);
    case "autofill_fetch":
      return (
        entry.message === "Greenhouse read succeeded (attempt 1)" &&
        details.attempt === 1 &&
        details.outcome === "succeeded" &&
        details.status === 200
      );
    case "application-autofill":
      // Retired providers emitted lowercase labels; do not broaden to unrelated messages.
      return /^Saved a (?:Greenhouse|lever|ashby) autofill script$/.test(
        entry.message,
      );
    case "application_preparation":
      return [
        "Queued combined application preparation",
        "Queued answers-only preparation",
      ].includes(entry.message);
    case "validation":
      return entry.message === "Draft validation passed";
    case "application_documents_generated":
      return /^Generated \d+ dated (?:resume|cover-letter) PDFs?$/.test(
        entry.message,
      );
    case "personal_updated":
      return [
        "Personal notes or workflow updated",
        "Opening reviewed when autofill script was copied",
      ].includes(entry.message);
    case "app_reload":
      return (
        entry.message === "Stopped generations and reloaded the app" &&
        details.interruptedTasks === 0 &&
        details.unconfirmedInterrupts === 0 &&
        Object.entries(details).every(
          ([key, value]) => !key.startsWith("interrupted") || value === 0,
        )
      );
    case "files_reindexed": {
      const summary = record(details.summary);
      const sections = record(details.validSections);
      return (
        entry.message === "Local files reindexed. No changes found." &&
        summary.sourceFilesChanged === 0 &&
        summary.incomplete === false &&
        ["companies", "openings", "documents"].every((kind) => {
          const changes = record(summary[kind]);
          return (
            sections[kind] === true &&
            ["added", "updated", "restored", "missing"].every(
              (key) => changes[key] === 0,
            )
          );
        })
      );
    }
    default:
      return false;
  }
}

export function migrateRoutineJournal(store: Store): boolean {
  return store.transaction(() => {
    if (
      store.db
        .prepare("SELECT 1 FROM migrations WHERE version=?")
        .get(journalPruningMigrationVersion)
    )
      return false;
    let removed = 0;
    for (const entry of store.list("journal")) {
      if (!isRoutineJournalEntry(entry)) continue;
      store.remove("journal", entry.id);
      removed++;
    }
    // The count belongs to migration provenance, not the user's activity journal.
    const columns = store.db.prepare("PRAGMA table_info(migrations)").all();
    if (!columns.some((column) => column.name === "details"))
      store.db.exec("ALTER TABLE migrations ADD COLUMN details TEXT");
    store.db
      .prepare(
        "INSERT INTO migrations(version,applied_at,details) VALUES(?,?,?)",
      )
      .run(
        journalPruningMigrationVersion,
        now(),
        JSON.stringify({ removedJournalEntries: removed }),
      );
    return removed > 0;
  });
}
