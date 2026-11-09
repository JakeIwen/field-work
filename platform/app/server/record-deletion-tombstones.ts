import { now, sha256, type Store } from "./storage.js";
import { deletionRowKey, type DeletionRow } from "./record-deletion-records.js";

/** Only identities remain, so source imports cannot resurrect deleted records. */
export function removeDeletionRow(store: Store, row: DeletionRow) {
  store.remove(row.kind, row.id);
  const identityHash = sha256(deletionRowKey(row));
  store.put("deleted_record", identityHash, {
    id: identityHash,
    kind: row.kind,
    identityHash,
    deletedAt: now(),
  });
}
