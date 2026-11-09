import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWrite, sha256, Store } from "../server/storage.js";
import type { Records } from "../server/records.js";
import {
  applyDocumentRetention,
  previewDocumentRetention,
} from "../server/document-retention.js";
import { inspectBackupIntegrity } from "../server/backup-integrity.js";

const put = (store: Store, kind: keyof Records, id: string, value: object) =>
  store.put(kind, id, { id, ...value } as never);
const taskId = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

/** One generation task: a private resume and cover letter, saved as drafts, objects and records. */
function generation(store: Store, n: number, openingId = "o1") {
  const id = taskId(n);
  const docs = (["resume", "cover-letter"] as const).map((kind) => {
    const bytes = Buffer.from(`%PDF ${openingId} ${kind} v${n}`);
    const hash = sha256(bytes);
    const relative = `exports/${kind}-v${n}.pdf`;
    atomicWrite(path.join(store.dataDir, "drafts", id, relative), bytes);
    atomicWrite(store.objectPath(hash), bytes);
    const doc = {
      kind,
      privacy: "private",
      scope: "tailored",
      origin: "generated",
      openingId,
      generatedBy: id,
      hash,
      name: `${kind}-v${n}.pdf`,
      path: path.relative(
        store.root,
        path.join(store.dataDir, "drafts", id, relative),
      ),
      createdAt: `2026-10-0${n}T00:00:00.000Z`,
    };
    put(
      store,
      "generated_document",
      `generated-${openingId}-${kind}-${n}`,
      doc,
    );
    return { id: `generated-${openingId}-${kind}-${n}`, hash, relative };
  });
  atomicWrite(
    path.join(store.dataDir, "drafts", id, "cover_letter.txt"),
    `letter ${n}`,
  );
  put(store, "task", id, {
    status: "completed",
    documentResult: { status: "ready", documentIds: docs.map((d) => d.id) },
  });
  put(store, "bundle", id, {
    artifacts: docs.map((d) => ({ path: d.relative, hash: d.hash })),
  });
  return docs;
}

function workspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "document-retention-"));
  return new Store(root, path.join(root, ".local/job-search"));
}

test("retention keeps the two newest versions and everything an application or current work uses", () => {
  const store = workspace();
  try {
    const [r1, l1] = generation(store, 1);
    const [r2, l2] = generation(store, 2);
    const [r3, l3] = generation(store, 3);
    const [r4, l4] = generation(store, 4);
    const [other] = generation(store, 5, "o2");
    // v1's resume was sent, so it stays; its letter does not.
    put(store, "application", "a1", {
      openingId: "o1",
      documentIds: [r4.id, l4.id],
      packages: [{ documents: [{ id: r1.id, hash: r1.hash }] }],
    });
    put(store, "application_autofill", "script-v2", {
      openingId: "o1",
      attachments: [
        { documentId: r2.id, hash: r2.hash },
        { documentId: l2.id, hash: l2.hash },
      ],
    });
    put(store, "application_autofill", "script-v4", {
      openingId: "o1",
      attachments: [
        { documentId: r4.id, hash: r4.hash },
        { documentId: l4.id, hash: l4.hash },
      ],
    });
    // The later run is the current one; the earlier one keeps nothing alive.
    put(store, "application_preparation", "run-old", {
      openingId: "o1",
      status: "ready",
      documentIds: [r2.id, l2.id],
      taskIds: [taskId(2)],
    });
    put(store, "application_preparation", "run-o1", {
      openingId: "o1",
      status: "ready",
      documentIds: [r4.id, l4.id],
      taskIds: [taskId(4)],
    });
    put(store, "generated_document", "generated-master", {
      kind: "resume",
      scope: "general",
      origin: "generated",
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    put(store, "journal", "j-gone", { type: "x", entityId: l2.id });
    put(store, "journal", "j-kept", { type: "x", entityId: r3.id });
    const latestLetter = store.get("generated_document", l4.id)!;
    put(store, "generated_document", l4.id, {
      ...latestLetter,
      previousVersionIds: [l3.id, l2.id, l1.id],
    });

    const preview = previewDocumentRetention(store);
    assert.deepEqual(
      preview.documents.map((d) => d.id).sort(),
      [l1.id, l2.id, r2.id].sort(),
    );
    assert.deepEqual(preview.scripts, ["script-v2"]);
    assert.deepEqual(preview.tasks, [taskId(2)]);
    assert.ok(
      store.get("generated_document", l2.id),
      "a preview changes nothing",
    );

    const result = applyDocumentRetention(store);
    assert.deepEqual(
      { ...result, objects: undefined },
      { documents: 3, scripts: 1, tasks: 1, files: 4, objects: undefined },
    );
    for (const doc of [l1, l2, r2]) {
      assert.equal(store.get("generated_document", doc.id), undefined);
      assert.equal(existsSync(store.objectPath(doc.hash)), false);
    }
    for (const doc of [r1, r3, l3, r4, l4, other])
      assert.ok(store.get("generated_document", doc.id), doc.id);
    assert.ok(store.get("generated_document", "generated-master"));
    // The v2 task had no document left, so its conversation, bundle and drafts go too.
    assert.equal(store.get("task", taskId(2)), undefined);
    assert.equal(store.get("bundle", taskId(2)), undefined);
    assert.equal(
      existsSync(path.join(store.dataDir, "drafts", taskId(2))),
      false,
    );
    // v1 keeps its sent resume; only the letter's copies and references go.
    assert.ok(store.get("task", taskId(1)));
    assert.equal(
      existsSync(path.join(store.dataDir, "drafts", taskId(1), l1.relative)),
      false,
    );
    assert.ok(
      existsSync(path.join(store.dataDir, "drafts", taskId(1), r1.relative)),
    );
    assert.deepEqual(
      store.get("bundle", taskId(1))!.artifacts?.map((a) => a.hash),
      [r1.hash],
    );
    assert.deepEqual(
      (store.get("task", taskId(1)) as any).documentResult.documentIds,
      [r1.id],
    );
    assert.deepEqual(
      store.get("generated_document", l4.id)!.previousVersionIds,
      [l3.id],
    );
    assert.equal(store.get("application_autofill", "script-v2"), undefined);
    assert.deepEqual(
      store.get("application_preparation", "run-old")!.documentIds,
      [],
    );
    assert.equal(store.get("journal", "j-gone"), undefined);
    assert.ok(store.get("journal", "j-kept"));
    assert.deepEqual(inspectBackupIntegrity(store).missingObjects, []);
    assert.equal(
      applyDocumentRetention(store).documents,
      0,
      "a second pass finds nothing",
    );
  } finally {
    store.close();
    rmSync(store.root, { recursive: true, force: true });
  }
});

test("retention scoped to one Opening leaves others and never touches running work", () => {
  const store = workspace();
  try {
    for (const n of [1, 2, 3]) generation(store, n);
    const [, oldLetter] = generation(store, 4, "o2");
    generation(store, 5, "o2");
    generation(store, 6, "o2");
    // A queued run still lists o2's oldest letter.
    put(store, "application_preparation", "run-o2", {
      openingId: "o2",
      status: "queued",
      documentIds: [],
      replaceDocumentIds: [oldLetter.id],
      taskIds: [],
    });
    assert.equal(applyDocumentRetention(store, ["o2"]).documents, 1);
    assert.equal(
      store.get("generated_document", "generated-o2-resume-4"),
      undefined,
    );
    assert.ok(store.get("generated_document", oldLetter.id));
    assert.ok(
      store.get("generated_document", "generated-o1-resume-1"),
      "o1 was out of scope",
    );
    assert.equal(applyDocumentRetention(store).documents, 2);
    assert.equal(
      store.get("generated_document", "generated-o1-resume-1"),
      undefined,
    );
  } finally {
    store.close();
    rmSync(store.root, { recursive: true, force: true });
  }
});

test("retention removes deleted task logs and scrubs copies in surviving histories, including empty histories", () => {
  const store = workspace();
  try {
    const [old] = generation(store, 1);
    generation(store, 2);
    const [current] = generation(store, 3);
    put(store, "task", "history-only", {
      status: "completed",
      events: [
        {
          method: "fixture",
          params: {
            documents: [
              { id: old.id, hash: old.hash },
              { id: current.id, hash: current.hash },
            ],
          },
        },
      ],
    });
    put(store, "task", "empty-history", {
      status: "completed",
      events: [{ method: "fixture", id: old.id }],
    });
    const oldTask = store.get("task", taskId(1))!;
    put(store, "task", oldTask.id, {
      ...oldTask,
      events: [{ method: "fixture", params: { bytes: "old task log" } }],
    });
    assert.equal(applyDocumentRetention(store).tasks, 1);
    assert.deepEqual(store.taskEvents(taskId(1)), []);
    assert.deepEqual(store.taskEvents("history-only"), [
      {
        method: "fixture",
        params: { documents: [{ id: current.id, hash: current.hash }] },
      },
    ]);
    assert.deepEqual(store.taskEvents("empty-history"), []);
    assert.equal(store.get("task", "empty-history")?.eventCount, 0);
    store.flushExport();
    assert.equal(
      JSON.stringify(store.personalExport()).includes(old.hash),
      false,
    );
  } finally {
    store.close();
    rmSync(store.root, { recursive: true, force: true });
  }
});

test("retention reads the live retained-version override", () => {
  const store = workspace();
  try {
    // The registry floor is 2 (Sam's 2026-10-19 rule), so four generations
    // leave room to see an override above the default take effect live.
    generation(store, 1);
    generation(store, 2);
    generation(store, 3);
    generation(store, 4);
    assert.equal(previewDocumentRetention(store).documents.length, 4);
    store.put("settings", "main", {
      ...store.settings(),
      tunables: { "documents.retainedVersions": 3 },
    });
    assert.equal(previewDocumentRetention(store).documents.length, 2);
    store.put("settings", "main", {
      ...store.settings(),
      tunables: { "documents.retainedVersions": 4 },
    });
    assert.equal(previewDocumentRetention(store).documents.length, 0);
  } finally {
    store.close();
    rmSync(store.root, { recursive: true, force: true });
  }
});
