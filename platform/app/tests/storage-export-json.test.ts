import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWrite, Store } from "../server/storage.js";
import { personalExportKinds } from "../server/storage-export-snapshot.js";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-export-json-"));
  const store = new Store(root, path.join(root, "data"));
  return {
    root,
    store,
    file: path.join(store.dataDir, "personal-export.json"),
    close() {
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("row-wise export is byte-identical to the snapshot API for every kind, row order, nested values and empty arrays", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1791600000000 });
  const f = fixture();
  const verify = () => {
    const expected = JSON.stringify(f.store.personalExport(), null, 2);
    f.store.flushExport();
    assert.equal(readFileSync(f.file, "utf8"), expected);
    assert.equal(statSync(f.file).mode & 0o777, 0o600);
    assert.equal(
      readdirSync(f.store.dataDir).filter((name) => name.endsWith(".tmp"))
        .length,
      0,
    );
  };
  try {
    verify();
    // Raw persisted payloads include historical shapes; the exporter must not reinterpret them.
    const insert = f.store.db.prepare(
      "INSERT OR REPLACE INTO records(kind,id,json) VALUES(?,?,?)",
    );
    for (const kind of personalExportKinds) {
      insert.run(
        kind,
        "second",
        '{"z":[null,true,false,{},[],{"text":"Résumé\\n保留\\ud800"}],"2":2,"1":1,"negative":-0,"decimal":1e-7}',
      );
      insert.run(
        kind,
        "first",
        '{"text":"second row despite id ordering","nested":{"values":[1,2,3]}}',
      );
    }
    verify();
    insert.run("personal", "second", '{"text":"replacement keeps row order"}');
    f.store.remove("task", "first");
    verify();
  } finally {
    f.close();
  }
});

test("partial serialization failure preserves the previous export, removes the temporary file and retries current data", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1791600000000 });
  t.mock.method(console, "error", () => {});
  const f = fixture();
  try {
    f.store.flushExport();
    const before = readFileSync(f.file);
    f.store.put("personal", "one", {
      id: "one",
      version: 1,
      notes: "Durable mutation",
    });
    f.store.db
      .prepare(
        "INSERT INTO records(kind,id,json) VALUES('journal','broken','{')",
      )
      .run();
    assert.throws(() => f.store.flushExport(), SyntaxError);
    assert.deepEqual(readFileSync(f.file), before);
    assert.equal(
      readdirSync(f.store.dataDir).filter((name) => name.endsWith(".tmp"))
        .length,
      0,
    );
    f.store.put("journal", "broken", {
      id: "broken",
      at: "",
      type: "test",
      message: "Recovered",
    });
    t.mock.timers.tick(2000);
    assert.equal(
      readFileSync(f.file, "utf8"),
      JSON.stringify(f.store.personalExport(), null, 2),
    );
  } finally {
    f.close();
  }
});

test("atomic chunk writes preserve private bytes, previous contents on failure and symlink guards", () => {
  const f = fixture();
  try {
    atomicWrite(f.file, "previous");
    function* broken() {
      yield "partial";
      throw Error("iterator failed");
    }
    assert.throws(() => atomicWrite(f.file, broken()), /iterator failed/);
    assert.equal(readFileSync(f.file, "utf8"), "previous");
    assert.equal(
      readdirSync(f.store.dataDir).filter((name) => name.endsWith(".tmp"))
        .length,
      0,
    );
    atomicWrite(f.file, ["Résumé", "\n保留"]);
    assert.equal(readFileSync(f.file, "utf8"), "Résumé\n保留");
    const linked = path.join(f.root, "linked");
    writeFileSync(linked, "do not replace");
    rmSync(f.file);
    symlinkSync(linked, f.file);
    assert.throws(() => atomicWrite(f.file, ["replace"]), /symlink/);
    assert.equal(readFileSync(linked, "utf8"), "do not replace");
    rmSync(f.file);
  } finally {
    f.close();
  }
});
