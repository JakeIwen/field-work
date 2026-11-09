import { tunables } from "../shared/tunables.js";
import type { Store } from "./storage.js";
import type { DatabaseSync } from "node:sqlite";
import type { Task, TaskEvent } from "../shared/task-records.js";
import type { SelectionEvent } from "../shared/model-selection.js";

export const retainedTaskEvents = tunables["models.taskEventCap"].default;
export type TaskEventRead = { limit?: number };

export function createTaskEventStorage(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS task_events (
    task_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL,
    selection_json TEXT, PRIMARY KEY(task_id,seq)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS task_client_request_id
    ON records(json_extract(json,'$.clientRequestId')) WHERE kind='task';
  CREATE TRIGGER IF NOT EXISTS task_events_delete AFTER DELETE ON records
    WHEN OLD.kind='task' BEGIN DELETE FROM task_events WHERE task_id=OLD.id; END;`);
}

function embeddedEvents(db: DatabaseSync, id: string): TaskEvent[] {
  const row = db
    .prepare(
      "SELECT json_extract(json,'$.events') AS events FROM records WHERE kind='task' AND id=?",
    )
    .get(id);
  if (typeof row?.events !== "string") return [];
  const events: unknown = JSON.parse(row.events);
  return Array.isArray(events) ? events : [];
}

export function hasTaskEventStorage(db: DatabaseSync) {
  return !!db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='task_events'",
    )
    .get();
}

export function readTaskEvents(
  db: DatabaseSync,
  id: string,
  { limit }: TaskEventRead = {},
): TaskEvent[] {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0))
    throw new RangeError("Task event limit must be a nonnegative integer");
  if (limit === 0) return [];
  if (!hasTaskEventStorage(db)) {
    const events = embeddedEvents(db, id);
    return limit === undefined ? events : events.slice(-limit);
  }
  const rows = db
    .prepare(
      "SELECT json FROM task_events WHERE task_id=? ORDER BY seq DESC LIMIT ?",
    )
    .all(id, limit ?? -1);
  // An interrupted migration can leave a read-only archive with both old and new tasks.
  if (!rows.length) {
    const events = embeddedEvents(db, id);
    return limit === undefined ? events : events.slice(-limit);
  }
  return rows.reverse().map((row) => JSON.parse(String(row.json)) as TaskEvent);
}

/** Keep attribution separate from tool output so an event never rereads heavy logs.
 * The projection preserves every field the shared model-selection rules consume. */
function selectionEvent(event: TaskEvent): SelectionEvent | undefined {
  const params = event.params;
  const item = params?.item;
  const itemId =
    item && typeof item === "object" && "id" in item ? item.id : undefined;
  if (
    !event.turnId &&
    !params?.turnId &&
    !params?.turn?.id &&
    !itemId &&
    !["adapter/threadCreated", "adapter/threadResumed"].includes(event.method)
  )
    return;
  return {
    method: event.method,
    turnId: event.turnId,
    selection: event.selection,
    params: {
      model: params?.model,
      effort: params?.effort,
      turnId: typeof params?.turnId === "string" ? params.turnId : undefined,
      turn: params?.turn ? { id: params.turn.id } : undefined,
      item: typeof itemId === "string" ? { id: itemId } : undefined,
    },
  };
}

export function readTaskSelectionEvents(
  db: DatabaseSync,
  id: string,
): SelectionEvent[] {
  if (!hasTaskEventStorage(db))
    return embeddedEvents(db, id).flatMap(
      (event) => selectionEvent(event) ?? [],
    );
  const rows = db
    .prepare(
      "SELECT selection_json FROM task_events WHERE task_id=? AND selection_json IS NOT NULL ORDER BY seq",
    )
    .all(id);
  if (!rows.length)
    return embeddedEvents(db, id).flatMap(
      (event) => selectionEvent(event) ?? [],
    );
  return rows.map(
    (row) => JSON.parse(String(row.selection_json)) as SelectionEvent,
  );
}

function writeEvent(
  db: DatabaseSync,
  id: string,
  seq: number,
  event: TaskEvent,
) {
  db.prepare(
    `INSERT INTO task_events(task_id,seq,json,selection_json) VALUES(?,?,?,?)
    ON CONFLICT(task_id,seq) DO UPDATE SET json=excluded.json,selection_json=excluded.selection_json`,
  ).run(
    id,
    seq,
    JSON.stringify(event),
    JSON.stringify(selectionEvent(event)) ?? null,
  );
}

export function replaceTaskEvents(
  db: DatabaseSync,
  id: string,
  events: TaskEvent[],
) {
  db.prepare("DELETE FROM task_events WHERE task_id=?").run(id);
  const insert = db.prepare(
    "INSERT INTO task_events(task_id,seq,json,selection_json) VALUES(?,?,?,?)",
  );
  events.forEach((event, index) =>
    insert.run(
      id,
      index + 1,
      JSON.stringify(event),
      JSON.stringify(selectionEvent(event)) ?? null,
    ),
  );
}

/** Caller puts the task's returned eventCount in the same transaction. */
export function appendTaskEvent(
  db: DatabaseSync,
  id: string,
  event: TaskEvent,
  at: string,
  count: number,
  cap: number = retainedTaskEvents,
): number {
  if (!db.isTransaction)
    throw new Error("Task events require a task-record transaction");
  const delta = event.method === "item/agentMessage/delta";
  const row = db
    .prepare(
      `SELECT seq${delta ? ",json" : ""} FROM task_events WHERE task_id=? ORDER BY seq DESC LIMIT 1`,
    )
    .get(id);
  const last: TaskEvent | undefined =
    row && delta ? JSON.parse(String(row.json)) : undefined;
  const coalesced =
    event.method === "item/agentMessage/delta" &&
    last?.method === event.method &&
    last.params?.itemId === event.params?.itemId &&
    last.turnId === event.turnId;
  const value = coalesced
    ? {
        ...event,
        at,
        params: {
          ...event.params,
          delta: (
            (((last?.params?.delta || "") as string) +
              (event.params?.delta || "")) as string
          ).slice(-200000),
        },
      }
    : { ...event, at };
  const seq = Number(row?.seq ?? 0) + (coalesced ? 0 : 1);
  writeEvent(db, id, seq, value);
  if (count + (coalesced ? 0 : 1) > cap)
    db.prepare("DELETE FROM task_events WHERE task_id=? AND seq<=?").run(
      id,
      seq - cap,
    );
  return Math.min(count + (coalesced ? 0 : 1), cap);
}

/** Importers and old fixtures may still supply events. Never put them back in records;
 * a nonempty legacy array deliberately replaces that task's event rows. Empty arrays
 * on metadata-only writes must not erase an existing conversation log. */
export function taskWithoutEmbeddedEvents(
  db: DatabaseSync,
  id: string,
  value: Task,
): Task {
  const { events, ...task } = value as Task & { events?: TaskEvent[] };
  if (Array.isArray(events) && events.length) {
    replaceTaskEvents(db, id, events);
    return { ...task, eventCount: events.length };
  }
  const count =
    task.eventCount ??
    Number(
      db
        .prepare(
          "SELECT json_extract(json,'$.eventCount') AS count FROM records WHERE kind='task' AND id=?",
        )
        .get(id)?.count ?? 0,
    );
  return { ...task, eventCount: count };
}

/** Cold deletion/retention passes may scrub an entire history, including to empty.
 * Keep that replacement and the metadata/cache invalidation in their outer transaction. */
export function putTaskWithEvents(
  store: Store,
  id: string,
  value: Task & { events: TaskEvent[] },
) {
  if (!store.db.isTransaction)
    throw new Error("Task history replacement requires a transaction");
  const { events, ...task } = value;
  replaceTaskEvents(store.db, id, events);
  return store.put("task", id, { ...task, eventCount: events.length });
}
