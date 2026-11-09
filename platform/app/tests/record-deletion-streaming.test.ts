import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, sha256, atomicWrite } from "../server/storage.js";
import { previewDeletion, deleteRecord } from "../server/record-deletion.js";
import {
  deletionRecordPlan,
  clearDeletionRecordPlan,
  deletionPreviewLifetimeMs,
} from "../server/record-deletion-records.js";
import { deletionHashRetention } from "../server/record-deletion-hashes.js";
import { hasEscapedDeletionJson } from "../server/record-deletion-json.js";
import { legacyTask, legacyDocument } from "./fixtures/legacy-records.js";

const taskId = "11111111-1111-4111-8111-111111111111";
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "deletion-streaming-"));
  const store = new Store(root, path.join(root, ".data"));
  t.after(() => {
    clearDeletionRecordPlan(store);
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return store;
}

for (const broad of [false, true])
  test(`hash retention respects decoded values and boundaries (${broad ? "broad" : "bounded"} screen)`, () => {
    const hash = sha256("shared object"),
      hashes = new Set([hash]);
    if (broad) for (let i = 0; i < 1100; i++) hashes.add(sha256(`other ${i}`));
    for (const prefix of ["", "\n", "\t", "\b", "\f", "\r", "é", " "]) {
      const retention = deletionHashRetention(hashes),
        value = { text: `${prefix}${hash}` };
      retention.retain(JSON.stringify(value), () => value);
      assert.ok(retention.retained.has(hash), JSON.stringify(prefix));
    }
    for (const value of [
      { [hash]: "key only" },
      { text: `a${hash}` },
      { text: `${hash}b` },
      { text: `\\n${hash}` },
    ]) {
      const retention = deletionHashRetention(hashes);
      retention.retain(JSON.stringify(value), () => value);
      assert.equal(retention.retained.has(hash), false);
    }
    const retention = deletionHashRetention(hashes),
      value = { text: hash };
    retention.retain(
      JSON.stringify(value).replace(
        hash,
        `\\u${hash.charCodeAt(0).toString(16).padStart(4, "0")}${hash.slice(1)}`,
      ),
      () => value,
    );
    assert.ok(retention.retained.has(hash));
  });

test("escape screening distinguishes encoded identities from literal script escapes", () => {
  const slash = String.fromCharCode(92);
  const unicode = (count: number) => `{"id":"${slash.repeat(count)}u0031"}`;
  assert.equal(hasEscapedDeletionJson(unicode(1)), true);
  assert.equal(hasEscapedDeletionJson(unicode(2)), false);
  assert.equal(hasEscapedDeletionJson(unicode(3)), true);
  assert.equal(hasEscapedDeletionJson(String.raw`{"id":"a\/b"}`), true);
  assert.equal(hasEscapedDeletionJson(String.raw`{"id":"a\\/b"}`), false);
});

test("shared hashes and textual mentions never hydrate entire unrelated histories", (t) => {
  const store = fixture(t),
    hash = sha256("shared");
  store.put("generated_document", "doc", legacyDocument({ id: "doc", hash }));
  atomicWrite(store.objectPath(hash), "shared");
  for (let i = 0; i < 12; i++) {
    const id = `22222222-2222-4222-8222-${String(i).padStart(12, "0")}`;
    store.put(
      "task",
      id,
      legacyTask({
        id,
        status: "completed",
        events: [
          {
            method: "tool/output",
            params: {
              text: `Text about doc, not a reference. ${`script(${String.fromCharCode(92)}u0020)`.repeat(4000)}\n${hash}`,
            },
          },
        ],
      }),
    );
  }
  const events = t.mock.method(store, "taskEvents");
  const preview = previewDeletion(store, "document", "doc");
  assert.equal(events.mock.callCount(), 0);
  assert.equal(preview.sharedFiles, 1);
  deleteRecord(store, "document", "doc", preview.token);
  assert.equal(events.mock.callCount(), 0);
  assert.equal(existsSync(store.objectPath(hash)), true);
});

test("event-only copies are removed and their hashes do not retain deleted objects", (t) => {
  const store = fixture(t),
    hash = sha256("only the removed copy");
  store.put("generated_document", "doc", legacyDocument({ id: "doc", hash }));
  atomicWrite(store.objectPath(hash), "only the removed copy");
  store.put(
    "task",
    taskId,
    legacyTask({
      id: taskId,
      status: "completed",
      events: [
        { method: "copy", params: { documents: [{ id: "doc", hash }] } },
        { method: "text", params: { text: 'This plain text says "doc".' } },
      ],
    }),
  );
  const p = previewDeletion(store, "document", "doc");
  assert.equal(p.sharedFiles, 0);
  deleteRecord(store, "document", "doc", p.token);
  assert.deepEqual(store.taskEvents(taskId), [
    { method: "copy", params: { documents: [] } },
    { method: "text", params: { text: 'This plain text says "doc".' } },
  ]);
  assert.equal(existsSync(store.objectPath(hash)), false);
});

test("a retained legacy parent left intact also retains its event-only objects", (t) => {
  const store = fixture(t),
    hash = sha256("legacy event");
  store.put("generated_document", "doc", legacyDocument({ id: "doc", hash }));
  atomicWrite(store.objectPath(hash), "legacy event");
  store.put(
    "task",
    taskId,
    legacyTask({
      id: "doc",
      status: "completed",
      events: [
        { method: "copy", params: { documents: [{ id: "doc", hash }] } },
      ],
    }),
  );
  const preview = previewDeletion(store, "document", "doc");
  assert.equal(preview.sharedFiles, 1);
  deleteRecord(store, "document", "doc", preview.token);
  assert.equal(
    store.taskEvents(taskId)[0]?.params?.documents instanceof Array,
    true,
  );
  assert.equal(existsSync(store.objectPath(hash)), true);
});

test("cached plans retain only file ownership, actual edits and full-record fingerprints", (t) => {
  const store = fixture(t),
    text = "private-history-canary";
  store.put(
    "task",
    taskId,
    legacyTask({
      id: taskId,
      status: "completed",
      messages: [{ role: "user", text }],
      events: [{ method: "history", params: { text } }],
    }),
  );
  store.put(
    "task",
    "other",
    legacyTask({
      id: "other",
      status: "completed",
      messages: [{ role: "user", text: "unrelated-history-canary" }],
    }),
  );
  const plan = deletionRecordPlan(store, "task", taskId);
  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes(text), false);
  assert.equal(serialized.includes("unrelated-history-canary"), false);
  assert.equal(
    plan.kept.some((row) => row.kind === "task"),
    false,
  );
  const preview = previewDeletion(store, "task", taskId);
  const task = store.get("task", taskId);
  assert.ok(task);
  store.put("task", taskId, {
    ...task,
    messages: [{ role: "user", text: "changed" }],
  });
  assert.throws(
    () => deleteRecord(store, "task", taskId, preview.token),
    /changed/,
  );
});

test("the single cached preview expires without requests and clears on writes and confirmation", (t) => {
  const store = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  store.put(
    "task",
    taskId,
    legacyTask({
      id: taskId,
      status: "completed",
      events: [{ method: "kept" }],
    }),
  );
  const events = t.mock.method(store, "taskEvents");
  const first = previewDeletion(store, "task", taskId);
  assert.equal(previewDeletion(store, "task", taskId).token, first.token);
  assert.equal(events.mock.callCount(), 1);
  t.mock.timers.tick(deletionPreviewLifetimeMs);
  assert.equal(previewDeletion(store, "task", taskId).token, first.token);
  assert.equal(events.mock.callCount(), 2);
  store.journal("note", "unrelated write");
  assert.equal(previewDeletion(store, "task", taskId).token, first.token);
  assert.equal(events.mock.callCount(), 3);
  assert.throws(
    () => deleteRecord(store, "task", taskId, "wrong token"),
    /changed/,
  );
  assert.equal(previewDeletion(store, "task", taskId).token, first.token);
  assert.equal(events.mock.callCount(), 4);
  deleteRecord(store, "task", taskId, first.token);
  assert.throws(() => previewDeletion(store, "task", taskId), { status: 404 });
});
