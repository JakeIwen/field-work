import { taskEventSequence } from "./fixtures/task-event-sequence.js";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, atomicWrite, sha256 } from "../server/storage.js";
import {
  migrateTaskEvents,
  taskEventsMigrationVersion,
} from "../server/storage-task-event-migration.js";
import {
  personalExportChanges,
  clearPersonalExportChanges,
} from "../server/storage-export-dirty.js";
import { inspectBackupIntegrity } from "../server/backup-integrity.js";
import { deleteRecord, previewDeletion } from "../server/record-deletion.js";
import {
  handleTaskEvent,
  type TaskEventServices,
} from "../server/task-kinds/registry.js";
import type { TaskEvent } from "../shared/task-records.js";
import {
  legacyTask,
  legacyBundle,
  legacyDocument,
} from "./fixtures/legacy-records.js";
import { applyTaskEvent as legacyApplyTaskEvent } from "./fixtures/legacy-task-events.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

function fixture(t: TestContext, embedded?: ReturnType<typeof legacyTask>[]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-task-events-"));
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir);
  const database = path.join(dataDir, "workspace.sqlite");
  if (embedded) {
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT INTO migrations VALUES(1,datetime('now')),(2,datetime('now')),(6,datetime('now')),(7,datetime('now'));`);
    for (const task of embedded)
      db.prepare("INSERT INTO records VALUES('task',?,?)").run(
        task.id,
        JSON.stringify(task),
      );
    db.close();
  }
  const stores: Store[] = [];
  t.after(() => {
    for (const store of stores.reverse()) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    dataDir,
    database,
    open: (readOnly = false) => {
      const store = new Store(root, dataDir, { readOnly });
      stores.push(store);
      return store;
    },
  };
}

function services(store: Store): TaskEventServices {
  return {
    store,
    publish() {},
    launchingTask: () => undefined,
    openingOperation: (_key, action) => action(),
    generatePreparedAutofill: async () => ({ id: "unused" }),
  };
}

const events = (count: number): TaskEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    method: "item/tool/output",
    turnId: "turn",
    at: `event-${index}`,
    params: { text: `Résumé ${index}`, index },
  }));

const rows = (store: Store, id: string) =>
  Number(
    store.db
      .prepare("SELECT count(*) AS count FROM task_events WHERE task_id=?")
      .get(id)?.count,
  );

test("startup migrates ordered events one task at a time without changing task metadata, and is idempotent", (t) => {
  const original = legacyTask({
    id: "first",
    preset: "opening-research",
    context: { openingId: "opening" },
    thread: { turns: ["detail-only"] },
    greenhousePull: {
      runId: "run",
      candidateId: "candidate",
      candidate: { body: "detail-only" },
    },
    version: 7,
    updatedAt: "original",
    events: events(2003),
  });
  const empty = legacyTask({ id: "empty" });
  const f = fixture(t, [original, empty]);
  const store = f.open();
  const { events: history, ...record } = original;
  assert.deepEqual(store.get("task", original.id), {
    ...record,
    eventCount: history.length,
  });
  assert.deepEqual(store.taskEvents(original.id), history);
  assert.deepEqual(
    store.taskEvents(original.id, { limit: 3 }),
    history.slice(-3),
  );
  assert.deepEqual(store.taskEvents(original.id, { limit: 0 }), []);
  assert.throws(() => store.taskEvents(original.id, { limit: -1 }), RangeError);
  const { thread: _thread, ...summary } = record;
  assert.equal(
    JSON.stringify(store.taskSummaries(original.id)),
    JSON.stringify([
      {
        ...summary,
        greenhousePull: { runId: "run", candidateId: "candidate" },
        eventCount: 500,
      },
    ]),
  );
  assert.deepEqual(
    store.taskSummaries(undefined, "opening"),
    store.taskSummaries(original.id),
  );
  assert.equal(store.taskSummaries(empty.id)[0].eventCount, 0);
  assert.equal(rows(store, original.id), history.length);
  assert.equal(migrateTaskEvents(store), false);
  assert.deepEqual(store.taskEvents(original.id), history);
  assert.ok(
    store.db
      .prepare("SELECT 1 FROM migrations WHERE version=?")
      .get(taskEventsMigrationVersion),
  );
  assert.ok(personalExportChanges(store).kinds.has("task"));
});

test("an interrupted migration commits complete tasks, retains the next embedded array and resumes without duplication", (t) => {
  const originals = ["first", "second", "third"].map((id) =>
    legacyTask({ id, events: events(3) }),
  );
  const f = fixture(t, originals);
  const inject = new DatabaseSync(f.database);
  inject.exec(`CREATE TRIGGER interrupt_migration BEFORE UPDATE ON records
    WHEN OLD.kind='task' AND OLD.id='second' BEGIN SELECT RAISE(ABORT,'interrupted fixture'); END;`);
  inject.close();
  assert.throws(() => f.open(), /interrupted fixture/);
  const check = new DatabaseSync(f.database);
  assert.equal(
    check.prepare("SELECT count(*) AS n FROM task_events").get()?.n,
    3,
  );
  assert.equal(
    check
      .prepare(
        "SELECT json_type(json,'$.events') AS type FROM records WHERE id='first'",
      )
      .get()?.type,
    null,
  );
  assert.equal(
    check
      .prepare(
        "SELECT json_type(json,'$.events') AS type FROM records WHERE id='second'",
      )
      .get()?.type,
    "array",
  );
  assert.equal(
    check
      .prepare("SELECT 1 FROM migrations WHERE version=?")
      .get(taskEventsMigrationVersion),
    undefined,
  );
  check.exec("DROP TRIGGER interrupt_migration");
  check.close();
  const historical = f.open(true);
  for (const original of originals)
    assert.deepEqual(historical.taskEvents(original.id), original.events);
  assert.equal(inspectBackupIntegrity(historical).ok, true);
  const resumed = f.open();
  for (const original of originals) {
    assert.deepEqual(resumed.taskEvents(original.id), original.events);
    assert.equal(rows(resumed, original.id), 3);
    assert.equal(resumed.get("task", original.id)?.eventCount, 3);
  }
});

test("read-only pre-migration archives support backup verification, event reads, summaries and exports without schema changes", (t) => {
  const original = legacyTask({ id: "old", events: events(510) });
  const f = fixture(t, [original]);
  const store = f.open(true);
  assert.equal(inspectBackupIntegrity(store).ok, true);
  assert.deepEqual(store.taskEvents(original.id), original.events);
  assert.deepEqual(
    store.taskEvents(original.id, { limit: 500 }),
    original.events.slice(-500),
  );
  assert.equal(store.taskSummaries()[0].eventCount, 500);
  assert.equal(store.taskSummaries()[0].events, undefined);
  assert.deepEqual(store.personalExport().records.task[0], original);
  assert.equal(
    store.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name='task_events'")
      .get(),
    undefined,
  );
});

test("legacy put replaces nonempty event arrays, metadata writes preserve them, and transactions roll back both halves", (t) => {
  const f = fixture(t),
    store = f.open();
  const task = legacyTask({
    id: "task",
    threadId: "thread",
    events: events(3),
  });
  store.put("task", task.id, task);
  assert.equal(Object.hasOwn(store.get("task", task.id)!, "events"), false);
  assert.equal(store.get("task", task.id)?.eventCount, 3);
  store.put(
    "task",
    task.id,
    legacyTask({ id: task.id, threadId: task.threadId, title: "Edited" }),
  );
  assert.deepEqual(store.taskEvents(task.id), task.events);
  assert.equal(store.get("task", task.id)?.eventCount, 3);
  const replacement = events(1);
  store.put("task", task.id, legacyTask({ ...task, events: replacement }));
  const before = store.get("task", task.id);
  clearPersonalExportChanges(store);
  assert.throws(
    () =>
      store.transaction(() => {
        store.put("task", task.id, legacyTask({ ...task, events: events(20) }));
        throw Error("rollback");
      }),
    /rollback/,
  );
  assert.deepEqual(store.get("task", task.id), before);
  assert.deepEqual(store.taskEvents(task.id), replacement);
  assert.equal(personalExportChanges(store).kinds.has("task"), false);
  assert.throws(
    () =>
      store.transaction(() => {
        store.remove("task", task.id);
        throw Error("rollback");
      }),
    /rollback/,
  );
  assert.deepEqual(store.taskEvents(task.id), replacement);
  store.remove("task", task.id);
  assert.equal(rows(store, task.id), 0);
});

test("event append, coalescing, trimming and task projections match the frozen old reducer", (t) => {
  const f = fixture(t),
    store = f.open(),
    runtime = services(store);
  const id = randomUUID();
  const bundle = legacyBundle({ id, artifacts: [] });
  mkdirSync(path.join(store.dataDir, "drafts", id), { recursive: true });
  store.put("bundle", id, bundle);
  let expected = legacyTask({
    id,
    threadId: "thread",
    events: events(2000),
    bundle,
  });
  store.put("task", expected.id, expected);
  let clock = 0;
  const send = (event: Parameters<typeof handleTaskEvent>[1]) => {
    event = {
      ...event,
      threadId: "thread",
      timestamp: `2026-10-01T00:00:${String(clock++).padStart(2, "0")}.000Z`,
    };
    expected = legacyApplyTaskEvent(expected, event, event.timestamp!);
    handleTaskEvent(runtime, event);
    assert.deepEqual(store.taskEvents(expected.id), expected.events);
    // The frozen reducer predates `activity`, which has its own tests (task-activity.test.ts).
    const { eventCount, activity, ...actual } = store.get("task", expected.id)!;
    assert.ok(activity);
    const { events: history, ...record } = expected;
    assert.deepEqual(actual, record);
    assert.equal(eventCount, history.length);
    assert.equal(
      store.taskSummaries(expected.id)[0].eventCount,
      Math.min(history.length, 500),
    );
  };
  for (const event of taskEventSequence) send(event);
});

test("event handling writes one log row and never parses historical tool payloads", (t) => {
  const f = fixture(t),
    store = f.open();
  const history = events(2000).map((event) => ({
    ...event,
    params: { text: "HEAVY_HISTORY_MARKER".repeat(50) },
  }));
  store.put(
    "task",
    "task",
    legacyTask({ id: "task", threadId: "thread", events: history }),
  );
  store.db.exec(`CREATE TEMP TABLE event_writes(operation TEXT);
    CREATE TEMP TRIGGER observe_event_insert AFTER INSERT ON task_events BEGIN INSERT INTO event_writes VALUES('insert'); END;
    CREATE TEMP TRIGGER observe_event_update AFTER UPDATE ON task_events BEGIN INSERT INTO event_writes VALUES('update'); END;
    CREATE TEMP TRIGGER observe_event_delete AFTER DELETE ON task_events BEGIN INSERT INTO event_writes VALUES('delete'); END;`);
  const parse = JSON.parse;
  let heavyReads = 0;
  t.mock.method(JSON, "parse", (text: string) => {
    if (text.includes("HEAVY_HISTORY_MARKER")) heavyReads++;
    return parse(text);
  });
  handleTaskEvent(services(store), {
    method: "item/tool/output",
    threadId: "thread",
  });
  assert.equal(heavyReads, 0);
  assert.deepEqual(
    store.db
      .prepare("SELECT operation FROM event_writes ORDER BY rowid")
      .all()
      .map((row) => row.operation),
    ["insert", "delete"],
  );
  const delta = {
    method: "item/agentMessage/delta",
    threadId: "thread",
    params: { itemId: "item", delta: "text" },
  };
  handleTaskEvent(services(store), delta);
  store.db.exec("DELETE FROM event_writes");
  handleTaskEvent(services(store), delta);
  assert.deepEqual(
    store.db
      .prepare("SELECT operation FROM event_writes")
      .all()
      .map((row) => row.operation),
    ["update"],
  );
  assert.equal(store.get("task", "task")?.eventCount, 2000);
});

test("failed event metadata writes roll back the appended row and export dirtiness", (t) => {
  const f = fixture(t),
    store = f.open();
  const task = legacyTask({
    id: "task",
    threadId: "thread",
    events: events(2),
  });
  store.put("task", task.id, task);
  const before = store.get("task", task.id);
  clearPersonalExportChanges(store);
  store.db
    .exec(`CREATE TEMP TRIGGER reject_task BEFORE UPDATE ON records WHEN OLD.kind='task'
    BEGIN SELECT RAISE(ABORT,'metadata failure'); END;`);
  assert.throws(
    () =>
      handleTaskEvent(services(store), {
        method: "item/agentMessage/delta",
        threadId: "thread",
        params: { delta: "Not committed" },
      }),
    /metadata failure/,
  );
  assert.deepEqual(store.get("task", task.id), before);
  assert.deepEqual(store.taskEvents(task.id), task.events);
  assert.equal(personalExportChanges(store).kinds.has("task"), false);
  store.db.exec("DROP TRIGGER reject_task");
});

test("event-only changes dirty task exports and reconstruct all events in chronological order", (t) => {
  const f = fixture(t),
    store = f.open();
  const task = legacyTask({
    id: "task",
    threadId: "thread",
    events: events(12),
  });
  store.put("task", task.id, task);
  store.flushExport();
  handleTaskEvent(services(store), {
    method: "item/agentMessage/delta",
    threadId: "thread",
    params: { delta: "New text" },
    timestamp: "now",
  });
  assert.equal(personalExportChanges(store).kinds.has("task"), true);
  store.flushExport();
  const exported = JSON.parse(
    readFileSync(path.join(f.dataDir, "personal-export.json"), "utf8"),
  );
  assert.deepEqual(exported.records.task[0].events, [
    ...task.events,
    {
      method: "item/agentMessage/delta",
      threadId: "thread",
      params: { delta: "New text" },
      timestamp: "now",
      at: "now",
    },
  ]);
  assert.deepEqual(exported.records.task, store.personalExport().records.task);
  assert.equal(personalExportChanges(store).kinds.has("task"), false);
});

test("permanent task deletion removes event rows and prevents resurrection", (t) => {
  const f = fixture(t),
    store = f.open();
  const task = legacyTask({ id: randomUUID(), events: events(8) });
  store.put("task", task.id, task);
  const preview = previewDeletion(store, "task", task.id);
  deleteRecord(store, "task", task.id, preview.token);
  assert.equal(store.get("task", task.id), undefined);
  assert.equal(rows(store, task.id), 0);
  assert.throws(() => store.put("task", task.id, task), /permanently deleted/);
  assert.deepEqual(store.taskEvents(task.id), []);
});

test("deletion scrubs surviving event histories, including empty results, and retains objects referenced only by events", (t) => {
  const f = fixture(t),
    store = f.open();
  const bytes = "shared object",
    hash = sha256(bytes);
  atomicWrite(store.objectPath(hash), bytes);
  store.put("generated_document", "doc", legacyDocument({ id: "doc", hash }));
  const onlyDeletedEvent = [{ method: "fixture", id: "doc" }];
  const sharedEvent = { method: "fixture", params: { hash } };
  store.put(
    "task",
    "empty",
    legacyTask({ id: "empty", events: onlyDeletedEvent }),
  );
  store.put(
    "task",
    "retained",
    legacyTask({ id: "retained", events: [...onlyDeletedEvent, sharedEvent] }),
  );
  const preview = previewDeletion(store, "document", "doc");
  assert.equal(preview.sharedFiles, 1);
  deleteRecord(store, "document", "doc", preview.token);
  assert.deepEqual(store.taskEvents("empty"), []);
  assert.equal(store.get("task", "empty")?.eventCount, 0);
  assert.deepEqual(store.taskEvents("retained"), [sharedEvent]);
  assert.equal(store.get("task", "retained")?.eventCount, 1);
  assert.equal(existsSync(store.objectPath(hash)), true);
});

test("client request lookup retains first-insertion order and uses the partial expression index", (t) => {
  const f = fixture(t),
    store = f.open();
  for (const id of ["second", "first", "last"])
    store.put(
      "task",
      id,
      legacyTask({ id, clientRequestId: "duplicate", events: events(2) }),
    );
  assert.equal(store.taskForClientRequest("duplicate")?.id, "second");
  store.put(
    "task",
    "second",
    legacyTask({
      id: "second",
      clientRequestId: "duplicate",
      title: "Updated",
    }),
  );
  assert.equal(store.taskForClientRequest("duplicate")?.title, "Updated");
  store.remove("task", "second");
  assert.equal(store.taskForClientRequest("duplicate")?.id, "first");
  assert.equal(store.taskForClientRequest("missing"), undefined);
  const plan = store.db
    .prepare(
      "EXPLAIN QUERY PLAN SELECT json FROM records WHERE kind='task' AND json_extract(json,'$.clientRequestId')=? ORDER BY rowid LIMIT 1",
    )
    .all("duplicate");
  assert.ok(
    plan.some((row) =>
      /USING INDEX task_client_request_id/.test(String(row.detail)),
    ),
    JSON.stringify(plan),
  );
});

test("events endpoint returns the newest 500 original records in order and 404 for missing tasks", async (t) => {
  const f = fixture(t);
  const workspace = await openFixtureWorkspace(f.root, f.dataDir);
  try {
    const history = events(701);
    workspace.store.put(
      "task",
      "task",
      legacyTask({ id: "task", events: history }),
    );
    const response = await workspace.get("/api/tasks/task/events");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { events: history.slice(-500) });
    assert.equal(
      (await workspace.get("/api/tasks/missing/events")).status,
      404,
    );
  } finally {
    await workspace.close();
  }
});
