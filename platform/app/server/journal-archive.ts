import {
  journalDeletionMaxIds,
  type JournalArchiveRequest,
  type JournalArchiveResult,
} from "../shared/activity.js";
import { HttpError, now, type Store } from "./storage.js";

/** Archiving hides handled notices from Activity without losing a record's history. */
export function archiveJournalEntries(
  store: Store,
  body: unknown,
): JournalArchiveResult {
  const request =
    body && typeof body === "object"
      ? (body as Partial<JournalArchiveRequest>)
      : {};
  const { ids, archived } = request;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > journalDeletionMaxIds ||
    ids.some((id) => typeof id !== "string" || !id.trim()) ||
    typeof archived !== "boolean"
  ) {
    throw new HttpError(
      400,
      `Choose 1–${journalDeletionMaxIds} nonblank journal IDs and whether to archive them.`,
    );
  }
  const unique = [...new Set(ids)];
  const at = now();
  const result = store.transaction(() => {
    let found = 0,
      updated = 0;
    for (const id of unique) {
      const entry = store.get("journal", id);
      if (!entry) continue;
      found++;
      if (Boolean(entry.archivedAt) === archived) continue;
      const next = { ...entry };
      if (archived) next.archivedAt = at;
      else delete next.archivedAt;
      store.put("journal", id, next);
      updated++;
    }
    return { updated, missing: unique.length - found };
  });
  if (result.updated) store.autoExport();
  return result;
}
