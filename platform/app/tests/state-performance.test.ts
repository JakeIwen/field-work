import type { Records } from "../server/records.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/storage.js";
import { singleFlightRefresh } from "../client/workspace/state-refresh.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-state-"));
  const store = new Store(root, path.join(root, "data"));
  return {
    store,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("page state omits heavy task history but retains live messages, approvals, usage and complete stored logs", () => {
  const f = fixture();
  try {
    const events = Array.from({ length: 550 }, (_, i) => ({
      method: "item/completed",
      params: { output: "x".repeat(1000), i },
    }));
    const task = {
      id: "one",
      threadId: "thread",
      status: "waiting for approval",
      events,
      thread: { thread: { turns: [{ items: events }] } },
      messages: [{ role: "assistant", text: "Public progress" }],
      pendingRequests: [{ requestId: "approval" }],
      liveText: "Working",
      usage: { total: { totalTokens: 50 } },
    };
    f.store.put(
      "task",
      task.id /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      task as unknown as Records["task"],
    );
    const projected = f.store.state().tasks[0];
    assert.equal(projected.events, undefined);
    assert.equal(projected.thread, undefined);
    assert.equal(projected.eventCount, 500);
    for (const key of [
      "messages",
      "pendingRequests",
      "liveText",
      "usage",
      "threadId",
      "status",
    ] as const)
      assert.deepEqual(projected[key], (task as any)[key]);
    assert.ok(
      JSON.stringify(projected).length < JSON.stringify(task).length / 100,
    );
    const { events: _events, ...record } = task;
    assert.deepEqual(f.store.get("task", "one"), {
      ...record,
      eventCount: events.length,
    });
    assert.deepEqual(f.store.taskEvents("one"), events);
    assert.deepEqual(f.store.personalExport().records.task[0].events, events);
  } finally {
    f.close();
  }
});

test("thread lookup stays current through task creation, updates, removal of a thread, and rollback", () => {
  const f = fixture();
  try {
    f.store.put(
      "task",
      "one" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      { id: "one", threadId: "first", version: 1 } as Records["task"],
    );
    assert.equal(f.store.taskForThread("first")!.id, "one");
    f.store.put(
      "task",
      "two" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      { id: "two", threadId: "second" } as Records["task"],
    );
    assert.equal(f.store.taskForThread("second")!.id, "two");
    f.store.put(
      "task",
      "one" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      { id: "one", threadId: "new", version: 2 } as Records["task"],
    );
    assert.equal(f.store.taskForThread("first"), undefined);
    assert.equal(f.store.taskForThread("new")!.version, 2);
    assert.throws(() =>
      f.store.transaction(() => {
        f.store.put(
          "task",
          "one" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
          { id: "one", threadId: "rolled-back" } as Records["task"],
        );
        throw Error("rollback");
      }),
    );
    assert.equal(f.store.taskForThread("rolled-back"), undefined);
    assert.equal(f.store.taskForThread("new")!.id, "one");
    f.store.put(
      "task",
      "one" /* Fixture preserves its minimal legacy payload rather than adding production metadata. */,
      { id: "one" } as Records["task"],
    );
    assert.equal(f.store.taskForThread("new"), undefined);
    assert.equal(f.store.taskForThread("unknown"), undefined);
  } finally {
    f.close();
  }
});

test("refresh bursts use one request plus one fresh follow-up, and waiters receive their own read", async () => {
  const releases: (() => void)[] = [];
  let active = 0,
    peak = 0;
  const refresh = singleFlightRefresh(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => releases.push(resolve));
    active--;
  });
  const first = refresh();
  const next = Array.from({ length: 20 }, () => refresh());
  assert.equal(releases.length, 1);
  releases[0]();
  await first;
  assert.equal(releases.length, 2);
  assert.equal(active, 1);
  releases[1]();
  await Promise.all(next);
  assert.equal(peak, 1);
  assert.equal(active, 0);
  const later = refresh();
  assert.equal(releases.length, 3);
  releases[2]();
  await later;
});

test("a failed refresh does not drop the queued recovery read or wedge future refreshes", async () => {
  let rejectFirst!: (error: Error) => void;
  let calls = 0;
  const refresh = singleFlightRefresh(async () => {
    if (++calls === 1)
      await new Promise<void>((_, reject) => {
        rejectFirst = reject;
      });
  });
  const first = refresh();
  const queued = refresh();
  rejectFirst(Error("temporary connection failure"));
  await assert.rejects(first, /temporary/);
  await queued;
  await refresh();
  assert.equal(calls, 3);
});
