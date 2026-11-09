import type { Task, TaskEvent } from "../shared/task-records.js";
import { now, type Store } from "./storage.js";
import { replaceTaskEvents } from "./storage-task-events.js";

export const taskEventsMigrationVersion = 8;

/** One task per transaction bounds memory and makes interruption resumable: the
 * embedded array disappears only when all its event rows have committed. */
export function migrateTaskEvents(store: Store): boolean {
  if (
    store.db
      .prepare("SELECT 1 FROM migrations WHERE version=?")
      .get(taskEventsMigrationVersion)
  )
    return false;
  // Only IDs are materialized; task JSON can exceed the machine's memory in aggregate.
  const ids = store.db
    .prepare("SELECT id FROM records WHERE kind='task' ORDER BY rowid")
    .all();
  let changed = false;
  for (const { id } of ids) {
    store.transaction(() => {
      const task = store.get("task", String(id)) as
        (Task & { events?: TaskEvent[] }) | undefined;
      if (!task || !Array.isArray(task.events)) return;
      const { events, ...record } = task;
      replaceTaskEvents(store.db, String(id), events);
      store.put("task", String(id), { ...record, eventCount: events.length });
      changed = true;
    });
  }
  store.db
    .prepare("INSERT INTO migrations(version,applied_at) VALUES(?,?)")
    .run(taskEventsMigrationVersion, now());
  return changed;
}
