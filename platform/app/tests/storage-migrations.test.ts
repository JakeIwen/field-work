import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../server/storage.js";
import { legacyOpening } from "./fixtures/legacy-records.js";

function legacyWorkspace() {
  const root = mkdtempSync(path.join(os.tmpdir(), "dismissal-migration-"));
  const dataDir = path.join(root, "data");
  const store = new Store(root, dataDir);
  for (const id of ["absent", "existing", "notes", "dismissed", "snapshot"]) {
    const opening = legacyOpening({
      id,
      url: `https://example.com/jobs/${id}`,
    });
    if (id !== "snapshot") store.put("cache_opening", id, opening);
    store.db
      .prepare("INSERT INTO records(kind,id,json) VALUES(?,?,?)")
      .run(
        "opening_archive",
        id,
        JSON.stringify({ id, archivedAt: "2026-10-12T00:00:00Z", opening }),
      );
  }
  store.put("personal", "existing", {
    id: "existing",
    version: 3,
    dismissed: false,
  });
  store.put("personal", "notes", {
    id: "notes",
    version: 7,
    notes: "Keep my private notes",
    saved: true,
    nextAction: "Keep this action",
    followUp: "2026-10-30",
  });
  store.put("personal", "dismissed", {
    id: "dismissed",
    version: 4,
    dismissed: true,
    updatedAt: "2026-10-12T00:00:00Z",
  });
  store.db.exec("DELETE FROM migrations WHERE version=2");
  store.close();
  return { root, dataDir };
}

function assertMigratedRecords(store: Store) {
  for (const id of ["absent", "existing", "notes", "dismissed", "snapshot"])
    assert.equal(store.state().personal[id]?.dismissed, true);
  assert.equal(store.get("personal", "absent")?.version, 1);
  assert.equal(store.get("personal", "existing")?.version, 4);
  const notes = store.get("personal", "notes");
  assert.equal(notes?.version, 8);
  assert.equal(notes?.notes, "Keep my private notes");
  assert.equal(notes?.saved, true);
  assert.equal(notes?.nextAction, "Keep this action");
  assert.equal(notes?.followUp, "2026-10-30");
  assert.deepEqual(store.get("personal", "dismissed"), {
    id: "dismissed",
    version: 4,
    dismissed: true,
    updatedAt: "2026-10-12T00:00:00Z",
  });
  assert.equal(
    store.opening("snapshot")?.url,
    "https://example.com/jobs/snapshot",
  );
  assert.equal(
    store.db
      .prepare("SELECT count(*) AS n FROM records WHERE kind='opening_archive'")
      .get()?.n,
    0,
  );
  const journal = store.list("journal");
  assert.equal(journal.length, 1);
  assert.equal(journal[0].type, "opening_dismissal_migration");
  assert.deepEqual(journal[0].details, {
    converted: 5,
    personalUpdated: 4,
    openingsRestored: 1,
  });
  assert.equal(journal[0].entityId, undefined);
}

test("startup converts old archive rows to Not interested once, preserving personal fields and snapshot-only vacancies", () => {
  const f = legacyWorkspace();
  let store = new Store(f.root, f.dataDir);
  try {
    assertMigratedRecords(store);
    const before = store.list("personal");
    store.flushExport();
    const exported = JSON.parse(
      readFileSync(path.join(f.dataDir, "personal-export.json"), "utf8"),
    );
    assert.equal("opening_archive" in exported.records, false);
    assert.equal(exported.records.personal.length, 5);
    assert.ok(
      exported.records.personal.every(
        (p: { dismissed: boolean }) => p.dismissed,
      ),
    );
    store.close();
    store = new Store(f.root, f.dataDir);
    assertMigratedRecords(store);
    assert.deepEqual(store.list("personal"), before);
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a failed dismissal migration rolls back personal changes, row deletion and the migration marker", () => {
  const f = legacyWorkspace();
  const db = new DatabaseSync(path.join(f.dataDir, "workspace.sqlite"));
  try {
    db.exec(`CREATE TRIGGER reject_migration BEFORE INSERT ON records
      WHEN NEW.kind='personal' AND NEW.id='notes'
      BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END`);
    assert.throws(
      () => new Store(f.root, f.dataDir),
      /injected migration failure/,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) AS n FROM records WHERE kind='opening_archive'",
        )
        .get()?.n,
      5,
    );
    assert.equal(
      db
        .prepare(
          "SELECT json FROM records WHERE kind='personal' AND id='absent'",
        )
        .get(),
      undefined,
    );
    assert.equal(
      db
        .prepare(
          "SELECT json_extract(json,'$.version') AS version FROM records WHERE kind='personal' AND id='existing'",
        )
        .get()?.version,
      3,
    );
    assert.equal(
      db.prepare("SELECT 1 FROM migrations WHERE version=2").get(),
      undefined,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM records WHERE kind='journal'").get()
        ?.n,
      0,
    );
    db.exec("DROP TRIGGER reject_migration");
    const recovered = new Store(f.root, f.dataDir);
    try {
      assertMigratedRecords(recovered);
    } finally {
      recovered.close();
    }
  } finally {
    db.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
