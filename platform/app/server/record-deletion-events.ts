import type { Store } from "./storage.js";
import { hasTaskEventStorage } from "./storage-task-events.js";

export type DeletionReferenceScan = {
  mayReference: (json: string) => boolean;
  scrub: (value: unknown) => unknown;
  retainHashes: (json: string, value: () => unknown) => void;
};

/** Stream individual events. A shared hash or a textual mention must not hydrate
 * and retain the entire conversation; only a real edit needs its complete log. */
export function scanDeletionEvents(
  store: Store,
  selectedTasks: Set<string>,
  preservedTasks: Set<string>,
  scan: DeletionReferenceScan,
) {
  const changed = new Set<string>();
  if (!hasTaskEventStorage(store.db)) return changed;
  const rows = store.db.prepare(`SELECT e.task_id,e.json FROM task_events e
    JOIN records r ON r.kind='task' AND r.id=e.task_id`);
  for (const row of rows.iterate()) {
    const id = String(row.task_id);
    if (selectedTasks.has(id)) continue;
    const json = String(row.json),
      matches = !preservedTasks.has(id) && scan.mayReference(json);
    let decoded = false,
      value: unknown,
      after: unknown;
    const read = () => {
      if (!decoded) {
        value = JSON.parse(json);
        after = matches ? (scan.scrub([value]) as unknown[])[0] : value;
        decoded = true;
      }
      return after;
    };
    if (matches) {
      read();
      if (after !== value) changed.add(id);
    }
    scan.retainHashes(json, read);
  }
  return changed;
}
