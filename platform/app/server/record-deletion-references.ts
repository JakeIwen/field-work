import type { Records } from "./records.js";
import { MissingRecordError, type Store } from "./storage.js";
import {
  deletionRowKey as key,
  type DeletionRow,
} from "./record-deletion-values.js";
import {
  scanDeletionEvents,
  type DeletionReferenceScan,
} from "./record-deletion-events.js";

type ScrubRecord = (row: DeletionRow) => DeletionRow["value"];

function retainedRecord(
  store: Store,
  raw: { kind: keyof Records; id: string; json: string },
  scan: DeletionReferenceScan,
  scrub: ScrubRecord,
) {
  const ignored = raw.kind === "deleted_record" || raw.kind === "settings";
  const matches =
    !ignored && (raw.kind === "meta" || scan.mayReference(raw.json));
  const legacyEvents = raw.kind === "task" && raw.json.includes('"events"');
  let decoded = false,
    row: DeletionRow,
    after: DeletionRow["value"];
  const read = () => {
    if (!decoded) {
      const value = JSON.parse(raw.json);
      if (legacyEvents && Object.hasOwn(value, "events"))
        value.events = store.taskEvents(raw.id);
      row = { kind: raw.kind, id: raw.id, value };
      after = ignored ? value : scrub(row);
      decoded = true;
    }
    // A retained parent removed wholesale by the scrub was historically left alone.
    return after || row.value;
  };
  let update: DeletionRow | undefined;
  if (matches || legacyEvents) {
    read();
    if (after && after !== row!.value) update = { ...row!, value: after };
  }
  scan.retainHashes(raw.json, read);
  return { update, preserveEvents: decoded && raw.kind === "task" && !after };
}

/** Walk raw rows one at a time and keep only actual edits. Most large tool output
 * is unrelated text, not a structural reference that deletion changes. */
export function scanDeletionReferences(
  store: Store,
  chosen: DeletionRow[],
  scan: DeletionReferenceScan,
  scrub: ScrubRecord,
) {
  const selected = new Set(chosen.map(key));
  const order = new Map<string, number>(),
    updates = new Map<string, DeletionRow>();
  const preservedTasks = new Set<string>();
  const rows = store.db.prepare(
    "SELECT kind,id,json FROM records ORDER BY kind,id",
  );
  for (const raw of rows.iterate()) {
    const row = raw as { kind: keyof Records; id: string; json: string };
    const identity = key(row);
    if (selected.has(identity)) continue;
    order.set(identity, order.size);
    const { update, preserveEvents } = retainedRecord(store, row, scan, scrub);
    if (update) updates.set(identity, update);
    if (preserveEvents) preservedTasks.add(row.id);
  }
  const tasks = scanDeletionEvents(
    store,
    new Set(chosen.filter((row) => row.kind === "task").map((row) => row.id)),
    preservedTasks,
    scan,
  );
  for (const row of updates.values())
    if (row.kind === "task") tasks.add(row.id);
  for (const id of tasks) {
    const value = store.get("task", id);
    if (!value)
      throw new MissingRecordError(
        409,
        "task",
        id,
        "A related task changed; review a fresh deletion preview.",
      );
    const row: DeletionRow = {
      kind: "task",
      id,
      value: { ...value, events: store.taskEvents(id) },
    };
    const after = scrub(row);
    if (after) updates.set(key(row), { ...row, value: after });
  }
  return [...updates.values()].sort(
    (a, b) => (order.get(key(a)) ?? 0) - (order.get(key(b)) ?? 0),
  );
}
