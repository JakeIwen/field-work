import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import path from "node:path";
import { Store } from "../server/storage.js";
import { personalExportKinds } from "../server/storage-export-snapshot.js";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { legacyTask } from "./fixtures/legacy-records.js";

const output = (store: Store) =>
  readFileSync(path.join(store.dataDir, "personal-export.json"), "utf8");
const fragment = (store: Store, kind: string) =>
  path.join(store.dataDir, "personal-export-fragments", `${kind}.json`);

function countTaskReads(t: TestContext) {
  const parse = JSON.parse;
  let reads = 0;
  t.mock.method(
    JSON,
    "parse",
    (text: string, reviver?: Parameters<typeof parse>[1]) => {
      if (text.includes("untouched marker")) reads++;
      return parse(text, reviver);
    },
  );
  return () => reads;
}

function seed(store: Store) {
  store.put(
    "task",
    "task",
    legacyTask({ id: "task", title: "untouched marker" }),
  );
  store.flushExport();
}

test("partial exports reuse unchanged kinds and preserve complete snapshot bytes after updates and deletes", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1791600000000 });
  const f = applicationAnswerFixture();
  try {
    seed(f.store);
    f.store.put("personal", "one", {
      id: "one",
      version: 1,
      notes: "保留 Résumé",
    });
    f.store.remove("settings", "main");
    const expected = JSON.stringify(f.store.personalExport(), null, 2);
    const reads = countTaskReads(t);
    f.store.flushExport();
    assert.equal(output(f.store), expected);
    assert.equal(reads(), 0, "unchanged tasks are not parsed/serialized again");
    assert.equal(statSync(fragment(f.store, "task")).mode & 0o777, 0o600);
  } finally {
    f.cleanup();
  }
});

for (const damage of ["missing", "corrupt", "registry"] as const)
  test(`${damage} fragment cache falls back to a full byte-identical export`, (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: 1791600000000 });
    const f = applicationAnswerFixture();
    try {
      seed(f.store);
      if (damage === "missing") rmSync(fragment(f.store, "personal"));
      if (damage === "corrupt")
        writeFileSync(fragment(f.store, "personal"), "bad");
      if (damage === "registry")
        Array.prototype.reverse.call(personalExportKinds);
      const expected = JSON.stringify(f.store.personalExport(), null, 2);
      const reads = countTaskReads(t);
      f.store.flushExport();
      assert.equal(output(f.store), expected);
      assert.equal(
        reads(),
        1,
        "all kinds are rebuilt, not just the damaged one",
      );
    } finally {
      if (damage === "registry")
        Array.prototype.reverse.call(personalExportKinds);
      f.cleanup();
    }
  });

test("restart discards fragment trust and rebuilds every kind from SQLite", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1791600000000 });
  const f = applicationAnswerFixture();
  seed(f.store);
  f.store.close();
  const store = new Store(f.root, f.store.dataDir);
  try {
    const expected = JSON.stringify(store.personalExport(), null, 2);
    const reads = countTaskReads(t);
    store.flushExport();
    assert.equal(output(store), expected);
    assert.equal(reads(), 1);
  } finally {
    store.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("a failed partial export retains dirty kinds and retry rebuilds every kind", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1791600000000 });
  t.mock.method(console, "error", () => {});
  const f = applicationAnswerFixture();
  try {
    seed(f.store);
    const previous = output(f.store);
    f.store.put("personal", "one", { id: "one", version: 1 });
    f.store.db.exec("INSERT INTO records VALUES ('journal', 'bad', '{')");
    assert.throws(() => f.store.flushExport(), SyntaxError);
    assert.equal(output(f.store), previous);
    f.store.remove("journal", "bad");
    const expected = JSON.stringify(
      {
        ...f.store.personalExport(),
        exportedAt: new Date(Date.now() + 2000).toISOString(),
      },
      null,
      2,
    );
    const reads = countTaskReads(t);
    t.mock.timers.tick(2000);
    assert.equal(output(f.store), expected);
    assert.equal(reads(), 1);
  } finally {
    f.cleanup();
  }
});
