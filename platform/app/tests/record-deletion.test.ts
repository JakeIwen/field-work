import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store, atomicWrite, sha256 } from "../server/storage.js";
import { previewDeletion, deleteRecord } from "../server/record-deletion.js";
import { parseOpenings } from "../server/import/parse-openings.js";
import { parseCompanies } from "../server/import/parse-companies.js";
import { DatabaseSync } from "node:sqlite";
import { legacyTask } from "./fixtures/legacy-records.js";

const taskId = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "record-deletion-"));
  const store = new Store(root, path.join(root, ".data"));
  const company = (id: string) =>
    `## ${id}\n<!-- company_id: ${id} -->\n- **Careers URL:** https://example.com/${id}\n`;
  const opening = (id: string) =>
    `### ${id} — Engineer\n<!-- company_id: ${id}; job_id: 1 -->\n* **Job URL:** https://example.com/${id}/1\n* **Compensation:** Unknown\n`;
  atomicWrite(
    path.join(root, "company_careers/companies.md"),
    "# Companies\n" + company("one") + company("two"),
  );
  atomicWrite(
    path.join(root, "company_careers/current_openings.md"),
    "# Openings\n**Qualifying current openings:** 2\n" +
      opening("one") +
      opening("two"),
  );
  for (const c of parseCompanies(
    readFileSync(path.join(root, "company_careers/companies.md"), "utf8"),
  ))
    store.put("cache_company", c.id, c);
  for (const o of parseOpenings(
    readFileSync(
      path.join(root, "company_careers/current_openings.md"),
      "utf8",
    ),
  ))
    store.put("cache_opening", o.id, o);
  const put = (kind: any, id: string, value: any) =>
    store.put(kind, id, { id, ...value });
  return {
    root,
    store,
    put,
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("company deletion removes only its sources, applications and generated data; shared objects survive", () => {
  const f = fixture();
  try {
    const unique = sha256("private generated data"),
      shared = sha256("shared bytes");
    atomicWrite(f.store.objectPath(unique), "private generated data");
    atomicWrite(f.store.objectPath(shared), "shared bytes");
    f.put("task", taskId, {
      status: "completed",
      context: { openingId: "one:1" },
      manifest: { hash: shared },
    });
    f.put("generated_document", "doc", {
      openingId: "one:1",
      generatedBy: taskId,
      hash: unique,
      name: "resume",
      path: "generated/resume.pdf",
    });
    f.put("application", "app", {
      openingId: "one:1",
      documentIds: ["doc"],
      packages: [{ documents: [{ id: "doc", hash: unique }] }],
    });
    f.put("application_autofill", "script", {
      openingId: "one:1",
      scriptHash: unique,
    });
    f.put("generated_document", "other-doc", {
      openingId: "two:1",
      hash: shared,
    });
    atomicWrite(
      path.join(f.store.dataDir, "drafts", taskId, "source.txt"),
      "private task evidence",
    );
    atomicWrite(
      path.join(
        f.root,
        "company_careers/research/scans/test/qualified_openings.json",
      ),
      JSON.stringify({
        openings: [
          { company_id: "one", job_id: "1" },
          { company_id: "two", job_id: "1" },
        ],
      }),
    );
    const p = previewDeletion(f.store, "company", "one");
    assert.ok(p.records.some((r) => r.kind === "application"));
    assert.ok(p.files.some((p) => p.endsWith(unique)));
    assert.ok(!p.files.some((p) => p.endsWith(shared)));
    deleteRecord(f.store, "company", "one", p.token);
    assert.equal(f.store.opening("one:1"), undefined);
    assert.ok(f.store.opening("two:1"));
    assert.equal(f.store.get("application", "app"), undefined);
    assert.equal(existsSync(f.store.objectPath(unique)), false);
    assert.equal(existsSync(f.store.objectPath(shared)), true);
    assert.equal(
      existsSync(path.join(f.store.dataDir, "drafts", taskId, "source.txt")),
      false,
    );
    assert.deepEqual(
      parseCompanies(
        readFileSync(path.join(f.root, "company_careers/companies.md"), "utf8"),
      ).map((c) => c.id),
      ["two"],
    );
    assert.deepEqual(
      parseOpenings(
        readFileSync(
          path.join(f.root, "company_careers/current_openings.md"),
          "utf8",
        ),
      ).map((o) => o.id),
      ["two:1"],
    );
    const snapshot = JSON.parse(
      readFileSync(
        path.join(
          f.root,
          "company_careers/research/scans/test/qualified_openings.json",
        ),
        "utf8",
      ),
    );
    assert.deepEqual(snapshot.openings, [{ company_id: "two", job_id: "1" }]);
    assert.throws(
      () => f.put("cache_opening", "one:1", {}),
      /permanently deleted/,
    );
    assert.ok(f.store.personalExport().records.deleted_record.length);
    assert.equal(f.store.get("generated_document", "other-doc")?.hash, shared);
  } finally {
    f.close();
  }
});

test("stale confirmation and active work reject deletion without touching sources", () => {
  const f = fixture();
  try {
    const p = previewDeletion(f.store, "opening", "one:1");
    f.put("personal", "one:1", { version: 1, notes: "new notes" });
    assert.throws(
      () => deleteRecord(f.store, "opening", "one:1", p.token),
      /changed/,
    );
    const current = previewDeletion(f.store, "opening", "one:1");
    f.put("task", taskId, {
      status: "running",
      context: { openingId: "one:1" },
    });
    assert.throws(
      () => deleteRecord(f.store, "opening", "one:1", current.token),
      /active/,
    );
    assert.match(
      readFileSync(
        path.join(f.root, "company_careers/current_openings.md"),
        "utf8",
      ),
      /company_id: one/,
    );
    assert.ok(f.store.opening("one:1"));
  } finally {
    f.close();
  }
});

test("only work the cascade removes blocks a deletion", () => {
  const f = fixture();
  try {
    // Work for another Opening, as when four preparations ran while Sam
    // deleted an unrelated Opening and the dialog stayed blocked for an hour.
    f.put("task", taskId, {
      status: "running",
      context: { openingId: "two:1" },
    });
    f.put("application_preparation", "prep-two", {
      openingId: "two:1",
      status: "running",
      taskIds: [],
    });
    assert.deepEqual(
      previewDeletion(f.store, "opening", "two:1").blockedBy?.sort(),
      ["Agent task", "two · Engineer"].sort(),
    );
    const p = previewDeletion(f.store, "opening", "one:1");
    assert.deepEqual(p.blockedBy, []);
    deleteRecord(f.store, "opening", "one:1", p.token);
    assert.equal(f.store.opening("one:1"), undefined);
    assert.equal(f.store.get("task", taskId)?.status, "running");
    f.put("career_scan", "scan", { status: "running" });
    assert.deepEqual(
      previewDeletion(f.store, "opening", "two:1").blockedBy?.sort(),
      ["Agent task", "Careers scan", "two · Engineer"],
    );
  } finally {
    f.close();
  }
});

test("deleting a document removes its source and package copies while keeping other documents", () => {
  const f = fixture();
  try {
    const hash = sha256("document");
    const file = path.join(f.root, "source_data/test.pdf");
    atomicWrite(file, "document");
    atomicWrite(f.store.objectPath(hash), "document");
    f.put("cache_document", "doc", {
      path: "source_data/test.pdf",
      hash,
      name: "test.pdf",
    });
    f.put("application", "app", {
      openingId: "two:1",
      documentIds: ["doc", "other"],
      packages: [
        {
          id: "pkg",
          documents: [
            { id: "doc", hash },
            { id: "other", hash: sha256("other") },
          ],
        },
      ],
    });
    const p = previewDeletion(f.store, "document", "doc");
    assert.ok(p.updatedRecords.some((r) => r.id === "app"));
    deleteRecord(f.store, "document", "doc", p.token);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(f.store.objectPath(hash)), false);
    assert.deepEqual(f.store.get("application", "app")!.documentIds, ["other"]);
    assert.deepEqual(
      f.store
        .get("application", "app")!
        .packages![0].documents.map((d) => d.id),
      ["other"],
    );
    assert.ok(existsSync(path.join(f.store.dataDir, "objects")));
  } finally {
    f.close();
  }
});

test("deletion refuses linked task directories and arbitrary record kinds", () => {
  const f = fixture();
  try {
    f.put("task", taskId, { status: "completed" });
    mkdirSync(path.join(f.store.dataDir, "drafts"));
    const outside = path.join(f.root, "outside");
    mkdirSync(outside);
    atomicWrite(path.join(outside, "keep"), "keep");
    const link = path.join(f.store.dataDir, "drafts", taskId);
    symlinkSync(outside, link);
    assert.throws(() => previewDeletion(f.store, "task", taskId), /linked/);
    assert.equal(readFileSync(path.join(outside, "keep"), "utf8"), "keep");
    unlinkSync(link);
    assert.throws(
      () => previewDeletion(f.store, "settings" as any, "main"),
      /Unsupported/,
    );
    assert.throws(
      () => previewDeletion(f.store, "task", "../outside"),
      /not found/,
    );
  } finally {
    f.close();
  }
});

test("a database failure restores removed files and source edits", () => {
  const f = fixture();
  try {
    const p = previewDeletion(f.store, "company", "one");
    f.store.db.exec(
      "CREATE TRIGGER reject_deletion BEFORE INSERT ON records WHEN NEW.kind='deleted_record' BEGIN SELECT RAISE(ABORT,'fixture failure'); END",
    );
    assert.throws(
      () => deleteRecord(f.store, "company", "one", p.token),
      /fixture failure/,
    );
    assert.ok(f.store.opening("one:1"));
    assert.match(
      readFileSync(path.join(f.root, "company_careers/companies.md"), "utf8"),
      /company_id: one/,
    );
  } finally {
    f.close();
  }
});

test("reindex cannot resurrect a deleted source identity", () => {
  const f = fixture();
  try {
    const company = f.store.get("cache_company", "one")!,
      opening = f.store.opening("one:1")!;
    deleteRecord(
      f.store,
      "company",
      "one",
      previewDeletion(f.store, "company", "one").token,
    );
    f.store.import({
      companies: [company],
      openings: [opening],
      documents: [],
      validSections: { companies: true, openings: true, documents: true },
      health: [],
      sourceHashes: {},
      scan: { timestamp: null, seenCount: 0, failedCompanies: [] },
      importedAt: new Date().toISOString(),
    } as any);
    assert.equal(f.store.get("cache_company", "one"), undefined);
    assert.equal(f.store.opening("one:1"), undefined);
  } finally {
    f.close();
  }
});

test("deleting a past document revision preserves its newer source bytes", () => {
  const f = fixture();
  try {
    const file = path.join(f.root, "source_data/resume.pdf");
    atomicWrite(file, "new");
    for (const version of ["old", "new"]) {
      const hash = sha256(version);
      atomicWrite(f.store.objectPath(hash), version);
      f.put("cache_document", version, {
        path: "source_data/resume.pdf",
        hash,
        availableInSource: version === "new",
      });
    }
    deleteRecord(
      f.store,
      "document",
      "old",
      previewDeletion(f.store, "document", "old").token,
    );
    assert.equal(readFileSync(file, "utf8"), "new");
    assert.equal(existsSync(f.store.objectPath(sha256("old"))), false);
    assert.ok(f.store.document("new"));
  } finally {
    f.close();
  }
});

test("leaf previews bind only the current row and ignore unrelated records, bytes and active work", () => {
  const f = fixture();
  try {
    for (const kind of ["journal", "filter"] as const) {
      const hash = sha256("not owned by a leaf");
      atomicWrite(f.store.objectPath(hash), "not owned by a leaf");
      f.put(kind, kind, { message: "saved", hash });
      f.put("task", taskId, { status: "running" });
      const preview = previewDeletion(f.store, kind, kind);
      assert.equal(preview.records.length, 1);
      assert.deepEqual(preview.files, []);
      f.put(kind, kind, { message: "changed", hash });
      assert.throws(
        () => deleteRecord(f.store, kind, kind, preview.token),
        /changed/,
      );
      const result = deleteRecord(
        f.store,
        kind,
        kind,
        previewDeletion(f.store, kind, kind).token,
      );
      assert.equal(result.reindex, false);
      assert.equal(f.store.get(kind, kind), undefined);
      assert.equal(existsSync(f.store.objectPath(hash)), true);
      assert.equal(f.store.get("task", taskId)?.status, "running");
    }
    assert.throws(() => previewDeletion(f.store, "journal", "missing"), {
      status: 404,
    });
  } finally {
    f.close();
  }
});

test("task-event scrubbing and event-only shared hashes survive selective hydration", (t) => {
  const f = fixture();
  try {
    const shared = sha256("shared in a retained event"),
      unique = sha256("only in removed copies");
    for (const hash of [shared, unique])
      atomicWrite(f.store.objectPath(hash), hash);
    f.put("generated_document", "doc", { hash: unique, sourceHash: shared });
    const affected = "22222222-2222-4222-8222-222222222222";
    f.store.put(
      "task",
      affected,
      legacyTask({
        id: affected,
        status: "completed",
        events: [
          {
            method: "removed-copy",
            params: { documents: [{ id: "doc", hash: unique }] },
          },
          { method: "shared-object", params: { hash: shared } },
        ],
      }),
    );
    f.store.put(
      "task",
      taskId,
      legacyTask({
        id: taskId,
        status: "completed",
        events: [
          {
            method: "unrelated",
            params: { text: "history that needs no hydration" },
          },
        ],
      }),
    );
    const read = t.mock.method(f.store, "taskEvents");
    const preview = previewDeletion(f.store, "document", "doc");
    assert.deepEqual(
      read.mock.calls.map((call) => call.arguments[0]),
      [affected],
    );
    assert.equal(preview.sharedFiles, 1);
    assert.ok(preview.files.some((file) => file.endsWith(unique)));
    assert.ok(!preview.files.some((file) => file.endsWith(shared)));
    deleteRecord(f.store, "document", "doc", preview.token);
    assert.deepEqual(
      read.mock.calls.map((call) => call.arguments[0]),
      [affected],
    );
    assert.deepEqual(f.store.taskEvents(affected), [
      { method: "removed-copy", params: { documents: [] } },
      { method: "shared-object", params: { hash: shared } },
    ]);
    assert.equal(f.store.taskEvents(taskId)[0]?.method, "unrelated");
    assert.equal(existsSync(f.store.objectPath(shared)), true);
    assert.equal(existsSync(f.store.objectPath(unique)), false);
  } finally {
    f.close();
  }
});

test("metadata-only task edits retain full unrelated event histories", () => {
  const f = fixture();
  try {
    f.put("generated_document", "doc", {});
    f.store.put(
      "task",
      taskId,
      legacyTask({
        id: taskId,
        status: "completed",
        context: { documentIds: ["doc", "keep"] },
        events: [{ method: "kept-event" }],
      }),
    );
    deleteRecord(
      f.store,
      "document",
      "doc",
      previewDeletion(f.store, "document", "doc").token,
    );
    assert.deepEqual(f.store.get("task", taskId)?.context.documentIds, [
      "keep",
    ]);
    assert.deepEqual(f.store.taskEvents(taskId), [{ method: "kept-event" }]);
  } finally {
    f.close();
  }
});

test("event screening finds encoded identities and split Opening identities", () => {
  const f = fixture();
  try {
    const id = 'app-é"\\identity';
    f.put("application", id, {});
    const event = {
      method: "copy",
      params: { application: { applicationId: id } },
    };
    f.store.put(
      "task",
      taskId,
      legacyTask({ id: taskId, status: "completed", events: [event] }),
    );
    f.store.db
      .prepare("UPDATE task_events SET json=? WHERE task_id=?")
      .run(JSON.stringify(event).replace("é", "\\u00e9"), taskId);
    deleteRecord(
      f.store,
      "application",
      id,
      previewDeletion(f.store, "application", id).token,
    );
    assert.deepEqual(f.store.taskEvents(taskId), [
      { method: "copy", params: {} },
    ]);
    f.store.put(
      "task",
      taskId,
      legacyTask({
        id: taskId,
        status: "completed",
        events: [
          {
            method: "snapshot",
            params: {
              openings: [
                { company_id: "one", job_id: "1" },
                { company_id: "two", job_id: "1" },
              ],
            },
          },
        ],
      }),
    );
    deleteRecord(
      f.store,
      "opening",
      "one:1",
      previewDeletion(f.store, "opening", "one:1").token,
    );
    assert.deepEqual(f.store.taskEvents(taskId)[0]?.params, {
      openings: [{ company_id: "two", job_id: "1" }],
    });
  } finally {
    f.close();
  }
});

test("record-plan reuse notices new events, external commits and rollback", () => {
  const f = fixture();
  try {
    f.put("application", "app", {});
    f.store.put(
      "task",
      taskId,
      legacyTask({ id: taskId, status: "completed" }),
    );
    const beforeEvents = previewDeletion(f.store, "application", "app");
    f.store.put(
      "task",
      taskId,
      legacyTask({
        id: taskId,
        status: "completed",
        events: [{ method: "copy", params: { applicationId: "app" } }],
      }),
    );
    assert.throws(
      () => deleteRecord(f.store, "application", "app", beforeEvents.token),
      /changed/,
    );
    const beforeExternal = previewDeletion(f.store, "application", "app");
    const external = new DatabaseSync(
      path.join(f.store.dataDir, "workspace.sqlite"),
    );
    try {
      external
        .prepare(
          "UPDATE records SET json=json_set(json,'$.notes',?) WHERE kind='application' AND id='app'",
        )
        .run("external edit");
    } finally {
      external.close();
    }
    assert.throws(
      () => deleteRecord(f.store, "application", "app", beforeExternal.token),
      /changed/,
    );
    const stable = previewDeletion(f.store, "application", "app");
    let transient = "";
    assert.throws(
      () =>
        f.store.transaction(() => {
          f.put("application", "app", { notes: "uncommitted" });
          transient = previewDeletion(f.store, "application", "app").token;
          throw new Error("rollback fixture");
        }),
      /rollback fixture/,
    );
    assert.notEqual(transient, stable.token);
    assert.equal(
      previewDeletion(f.store, "application", "app").token,
      stable.token,
    );
    deleteRecord(f.store, "application", "app", stable.token);
    assert.deepEqual(f.store.taskEvents(taskId), [{ method: "copy" }]);
  } finally {
    f.close();
  }
});

test("cached record plans still recheck file bytes, new files and symlinks", () => {
  const f = fixture();
  try {
    f.store.put(
      "task",
      taskId,
      legacyTask({ id: taskId, status: "completed" }),
    );
    const dir = path.join(f.store.dataDir, "drafts", taskId),
      file = path.join(dir, "draft.txt");
    atomicWrite(file, "before");
    const preview = previewDeletion(f.store, "task", taskId);
    atomicWrite(file, "after");
    assert.throws(
      () => deleteRecord(f.store, "task", taskId, preview.token),
      /changed/,
    );
    const changed = previewDeletion(f.store, "task", taskId);
    const added = path.join(dir, "added.txt");
    atomicWrite(added, "new file");
    assert.throws(
      () => deleteRecord(f.store, "task", taskId, changed.token),
      /changed/,
    );
    unlinkSync(added);
    unlinkSync(file);
    symlinkSync(path.join(f.root, "company_careers/companies.md"), file);
    assert.throws(
      () => deleteRecord(f.store, "task", taskId, changed.token),
      /linked/,
    );
    assert.ok(f.store.get("task", taskId));
  } finally {
    f.close();
  }
});

test("reindex is required for imported sources, not generated objects and drafts", () => {
  const f = fixture();
  try {
    const hash = sha256("generated document");
    atomicWrite(f.store.objectPath(hash), "generated document");
    f.put("generated_document", "doc", { hash });
    const generated = deleteRecord(
      f.store,
      "document",
      "doc",
      previewDeletion(f.store, "document", "doc").token,
    );
    assert.equal(generated.reindex, false);
    const opening = deleteRecord(
      f.store,
      "opening",
      "one:1",
      previewDeletion(f.store, "opening", "one:1").token,
    );
    assert.equal(opening.reindex, true);
  } finally {
    f.close();
  }
});

test("opening deletion removes both source and custom identities for the same URL", () => {
  const f = fixture();
  try {
    f.put("custom_opening", "custom-one", {
      ...f.store.opening("one:1"),
      id: "custom-one",
    });
    const p = previewDeletion(f.store, "opening", "custom-one");
    assert.ok(p.records.some((r) => r.id === "one:1"));
    deleteRecord(f.store, "opening", "custom-one", p.token);
    assert.equal(
      f.store.openings().some((o) => o.url === "https://example.com/one/1"),
      false,
    );
    assert.throws(
      () => f.put("custom_opening", "one:1", {}),
      /permanently deleted/,
    );
  } finally {
    f.close();
  }
});
