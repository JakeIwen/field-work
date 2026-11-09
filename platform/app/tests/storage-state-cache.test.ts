import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/storage.js";
import { legacyTask } from "./fixtures/legacy-records.js";
import {
  stateCacheFixture,
  stateCacheRecords,
} from "./fixtures/state-cache.js";
import { uncachedState } from "./fixtures/uncached-state.js";

function assertUncachedBytes(store: Store) {
  assert.equal(
    JSON.stringify(store.state()),
    JSON.stringify(uncachedState(store)),
  );
}

for (const kind of Object.keys(
  stateCacheRecords,
) as (keyof typeof stateCacheRecords)[]) {
  test(`state invalidates ${kind} projections after put and remove`, () => {
    const f = stateCacheFixture();
    try {
      assertUncachedBytes(f.store);
      const before = JSON.stringify(f.store.state());
      const value = stateCacheRecords[kind];
      const id = kind === "meta" ? "import" : "id" in value ? value.id : "";
      // Extra persisted fields are deliberately preserved in legacy JSON records.
      const changedValue = { ...value, cacheProbe: "changed" };
      f.store.put(kind, id, changedValue);
      // Generation counts use only these fields, not unrelated metadata.
      if (kind === "application_preparation")
        f.store.put(kind, id, {
          ...stateCacheRecords.application_preparation,
          openingId: "other-opening",
        });
      if (kind === "cache_opening")
        f.store.put(kind, id, {
          ...stateCacheRecords.cache_opening,
          title: "Updated source title",
        });
      if (kind === "custom_opening")
        f.store.put(kind, id, {
          ...stateCacheRecords.custom_opening,
          company: "Updated personal company",
        });
      assert.notEqual(JSON.stringify(f.store.state()), before);
      assertUncachedBytes(f.store);
      const changed = JSON.stringify(f.store.state());
      f.store.remove(kind, id);
      assert.notEqual(JSON.stringify(f.store.state()), changed);
      assertUncachedBytes(f.store);
    } finally {
      f.close();
    }
  });
}

test("task writes retain unrelated projections and refresh only changed summaries in row order", (t) => {
  const f = stateCacheFixture();
  try {
    f.store.put("task", "z-first", legacyTask({ id: "z-first" }));
    f.store.put("task", "a-last", legacyTask({ id: "a-last" }));
    const initial = f.store.state();
    const single = f.store.taskSummaries.bind(f.store);
    const calls: (string | undefined)[] = [];
    t.mock.method(
      f.store,
      "taskSummaries",
      (id?: string, openingId?: string) => {
        calls.push(id);
        return single(id, openingId);
      },
    );
    const same = f.store.state();
    assert.equal(same.tasks, initial.tasks);
    assert.deepEqual(calls, []);
    f.store.put(
      "task",
      "z-first",
      legacyTask({
        id: "z-first",
        liveText: "Changed",
        events: [{ method: "done" }],
      }),
    );
    const changed = f.store.state();
    assert.deepEqual(calls, ["z-first"]);
    assert.deepEqual(changed.tasks, single());
    assert.equal(changed.tasks[0], initial.tasks[0]);
    for (const key of [
      "companies",
      "openings",
      "documents",
      "personal",
      "applications",
      "journal",
      "savedFilters",
      "openingGenerationCounts",
      "health",
    ] as const)
      assert.equal(changed[key], initial[key], key);
    f.store.remove("task", "task");
    f.store.put("task", "new", legacyTask({ id: "new" }));
    f.store.remove("task", "z-first");
    f.store.put(
      "task",
      "z-first",
      legacyTask({ id: "z-first", liveText: "Reinserted" }),
    );
    const reordered = f.store.state();
    assert.deepEqual(
      reordered.tasks.map((task) => task.id),
      ["a-last", "new", "z-first"],
    );
    assert.deepEqual(reordered.tasks, single());
    assert.ok(calls.every((id) => id !== undefined));
  } finally {
    f.close();
  }
});

test("rollback invalidates values built from uncommitted records", () => {
  const f = stateCacheFixture();
  try {
    const original = JSON.stringify(f.store.state());
    assert.throws(
      () =>
        f.store.transaction(() => {
          f.store.put(
            "task",
            "task",
            legacyTask({ id: "task", liveText: "Will roll back" }),
          );
          f.store.remove("custom_opening", "custom-opening");
          f.store.put("personal", "source-company", {
            id: "source-company",
            version: 2,
            pendingWatchlist: false,
          });
          assert.notEqual(JSON.stringify(f.store.state()), original);
          throw new Error("Abort fixture");
        }),
      /Abort fixture/,
    );
    assert.equal(JSON.stringify(f.store.state()), original);
    assertUncachedBytes(f.store);
  } finally {
    f.close();
  }
});

test("raw SQL insert, update, kind/id moves and bulk deletes invalidate their projections", () => {
  const f = stateCacheFixture();
  try {
    f.store.state();
    const changed = { ...stateCacheRecords.cache_company, name: "Raw SQL" };
    f.store.db
      .prepare("UPDATE records SET json=? WHERE kind='cache_company'")
      .run(JSON.stringify(changed));
    assert.equal(f.store.state().companies[0].name, "Raw SQL");
    f.store.db
      .prepare(
        "UPDATE records SET kind='custom_company',id='moved' WHERE kind='cache_company'",
      )
      .run();
    assertUncachedBytes(f.store);
    f.store.db
      .prepare("INSERT INTO records VALUES('task','raw',?)")
      .run(JSON.stringify(legacyTask({ id: "raw" })));
    assertUncachedBytes(f.store);
    f.store.db.exec(
      "DELETE FROM records WHERE kind IN ('task','custom_company','filter')",
    );
    assertUncachedBytes(f.store);
    assert.deepEqual(f.store.state().tasks, []);
    assert.deepEqual(f.store.state().companies, []);
  } finally {
    f.close();
  }
});

test("another connection's commit invalidates all projections, including on a read-only Store", () => {
  const f = stateCacheFixture();
  const second = new DatabaseSync(
    path.join(f.store.dataDir, "workspace.sqlite"),
  );
  const reader = new Store(f.root, f.store.dataDir, { readOnly: true });
  try {
    const before = f.store.state();
    reader.state();
    second
      .prepare("UPDATE records SET json=? WHERE kind='task' AND id='task'")
      .run(
        JSON.stringify(legacyTask({ id: "task", liveText: "Other process" })),
      );
    assert.equal(f.store.state().tasks[0].liveText, "Other process");
    assert.notEqual(f.store.state().companies, before.companies);
    assert.equal(reader.state().tasks[0].liveText, "Other process");
    second.exec("DELETE FROM records WHERE kind='custom_opening'");
    assertUncachedBytes(f.store);
    assertUncachedBytes(reader);
  } finally {
    reader.close();
    second.close();
    f.close();
  }
});

test("an external commit between dependent reads cannot poison the next cached response", (t) => {
  const f = stateCacheFixture();
  const second = new DatabaseSync(
    path.join(f.store.dataDir, "workspace.sqlite"),
  );
  try {
    const list = f.store.list.bind(f.store);
    let committed = false;
    t.mock.method(f.store, "list", (kind: Parameters<typeof list>[0]) => {
      const values = list(kind);
      if (kind === "personal" && !committed) {
        committed = true;
        second.prepare("UPDATE records SET json=? WHERE kind='personal'").run(
          JSON.stringify({
            ...stateCacheRecords.personal,
            pendingWatchlist: false,
          }),
        );
      }
      return values;
    });
    f.store.state();
    assert.ok(committed);
    assert.equal(
      f.store.state().health.some((item) => item.id === "pending-watchlist"),
      false,
    );
    assertUncachedBytes(f.store);
  } finally {
    second.close();
    f.close();
  }
});

test("cached records and nested arrays are immutable without freezing caller inputs or settings", () => {
  const f = stateCacheFixture();
  try {
    const input = { id: "editable", version: 1, notes: "Before" };
    f.store.put("personal", input.id, input);
    const state = f.store.state();
    assert.throws(() => {
      state.personal.editable.notes = "Corrupt cache";
    }, TypeError);
    assert.throws(() => {
      state.companies[0].fields.changed = "Corrupt cache";
    }, TypeError);
    assert.throws(() => {
      state.tasks[0].messages.push({ role: "user", text: "Changed" });
    }, TypeError);
    assert.throws(() => {
      f.store.openings().pop();
    }, TypeError);
    const opening = f.store.opening("custom-opening");
    assert.ok(opening);
    assert.throws(() => {
      opening.company = "Changed";
    }, TypeError);
    input.notes = "Editable input";
    state.settings.timezone = "UTC";
    assert.equal(f.store.state().personal.editable.notes, "Before");
    assert.notEqual(f.store.state().settings.timezone, "UTC");
    assertUncachedBytes(f.store);
  } finally {
    f.close();
  }
});

test("journal selects the latest 400 inserted rows, not ID or timestamp order", () => {
  const f = stateCacheFixture();
  try {
    for (let i = 0; i < 440; i++)
      f.store.put("journal", `journal-${440 - i}`, {
        ...stateCacheRecords.journal,
        id: `journal-${440 - i}`,
        message: String(i),
      });
    assert.deepEqual(
      f.store.state().journal,
      f.store.list("journal").slice(-400).reverse(),
    );
    f.store.remove("journal", "journal-1");
    assertUncachedBytes(f.store);
  } finally {
    f.close();
  }
});
