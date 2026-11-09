import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { HttpError, Store } from "../server/storage.js";
import { activityLog } from "../server/activity-log.js";
import { archiveJournalEntries } from "../server/journal-archive.js";
import { recordDetail } from "../server/record-detail.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "journal-archive-"));
  const store = new Store(root, path.join(root, "data"));
  return { root, store };
}

const messages = (store: Store, archived?: "active" | "archived" | "all") =>
  activityLog(store, { archived }).entries.map((entry) => entry.message);

test("archived entries leave the default activity view, counts and pages, and restore exactly", () => {
  const { root, store } = fixture();
  try {
    const kept = store.journal("validation", "Kept warning", "opening-1");
    const handled = store.journal("validation", "Handled warning", "opening-1");
    const before = store.get("journal", handled.id);

    assert.deepEqual(
      archiveJournalEntries(store, {
        ids: [handled.id, "gone"],
        archived: true,
      }),
      { updated: 1, missing: 1 },
    );
    assert.deepEqual(messages(store), [kept.message]);
    assert.equal(activityLog(store, {}).total, 1);
    assert.deepEqual(messages(store, "archived"), [handled.message]);
    assert.ok(
      activityLog(store, { archived: "archived" }).entries[0].archivedAt,
    );
    assert.deepEqual(
      messages(store, "all").sort(),
      [handled.message, kept.message].sort(),
    );
    // A repeated archive is a no-op, so the original archive time survives.
    assert.deepEqual(
      archiveJournalEntries(store, { ids: [handled.id], archived: true }),
      { updated: 0, missing: 0 },
    );

    assert.deepEqual(
      archiveJournalEntries(store, { ids: [handled.id], archived: false }),
      { updated: 1, missing: 0 },
    );
    assert.deepEqual(store.get("journal", handled.id), before);
    assert.deepEqual(messages(store, "archived"), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a record's own history keeps its archived entries", () => {
  const { root, store } = fixture();
  try {
    store.put("custom_company", "company-1", {
      id: "company-1",
      name: "Example",
    } as never);
    const entry = store.journal("validation", "Archived note", "company-1");
    archiveJournalEntries(store, { ids: [entry.id], archived: true });
    assert.deepEqual(
      activityLog(store, { entity: ["company-1"] }).entries.map((e) => e.id),
      [],
    );
    assert.deepEqual(
      recordDetail(store, "company", "company-1").activity.map((e) => e.id),
      [entry.id],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("archive requests and scopes are validated", () => {
  const { root, store } = fixture();
  try {
    for (const body of [
      undefined,
      { ids: [], archived: true },
      { ids: ["one"] },
      { ids: [" "], archived: true },
      { ids: Array.from({ length: 501 }, (_, i) => `id-${i}`), archived: true },
    ])
      assert.throws(
        () => archiveJournalEntries(store, body),
        (error) => error instanceof HttpError && error.status === 400,
      );
    assert.throws(
      () => activityLog(store, { archived: "hidden" as never }),
      (error) => error instanceof HttpError && error.status === 400,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
