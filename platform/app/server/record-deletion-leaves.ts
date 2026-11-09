import type {
  DeletionKind,
  DeletionPreview,
} from "../shared/record-deletion.js";
import {
  journalDeletionMaxIds,
  type JournalDeletionRequest,
  type JournalDeletionResult,
} from "../shared/activity.js";
import {
  HttpError,
  MissingRecordError,
  sha256,
  type Store,
} from "./storage.js";
import {
  deletionRowTitle,
  type DeletionRow,
} from "./record-deletion-records.js";
import { removeDeletionRow } from "./record-deletion-tombstones.js";
import type { DeletionFileEdit } from "./record-deletion.js";

type LeafKind = "journal" | "filter";
export const isDeletionLeaf = (kind: DeletionKind): kind is LeafKind =>
  kind === "journal" || kind === "filter";

export function leafDeletionPlan(store: Store, kind: LeafKind, id: string) {
  const value = store.get(kind, id);
  if (!value)
    throw new MissingRecordError(
      404,
      kind,
      id,
      "Record not found; it may already have been deleted.",
    );
  const row: DeletionRow = { kind, id, value };
  return {
    preview: {
      title: deletionRowTitle(row),
      token: sha256(JSON.stringify(row)),
      records: [{ kind, id, title: deletionRowTitle(row) }],
      updatedRecords: [],
      files: [],
      editedFiles: [],
      sharedFiles: 0,
    } satisfies DeletionPreview,
    chosen: [row],
    updates: [] as DeletionRow[],
    edits: new Map<string, DeletionFileEdit>(),
  };
}

export function deleteJournalRecords(
  store: Store,
  body: unknown,
): JournalDeletionResult {
  const ids =
    body && typeof body === "object"
      ? (body as Partial<JournalDeletionRequest>).ids
      : undefined;
  if (
    !Array.isArray(ids) ||
    !ids.length ||
    ids.length > journalDeletionMaxIds ||
    ids.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new HttpError(
      400,
      `Choose 1–${journalDeletionMaxIds} nonblank journal IDs.`,
    );
  }
  const unique = [...new Set(ids)];
  const result = store.transaction(() => {
    let deleted = 0;
    for (const id of unique) {
      const value = store.get("journal", id);
      if (!value) continue;
      removeDeletionRow(store, { kind: "journal", id, value });
      deleted++;
    }
    return { deleted, missing: unique.length - deleted };
  });
  if (result.deleted) store.autoExport();
  return result;
}
