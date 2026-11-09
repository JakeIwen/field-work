import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { blockPersonalExport } from "./fixtures/export-writer.js";

const snapshot = (directory: string) =>
  JSON.parse(
    readFileSync(path.join(directory, "personal-export.json"), "utf8"),
  );

test("failed explicit flush leaves an armed retry in an otherwise idle Store", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
  t.mock.method(console, "error", () => {});
  const f = applicationAnswerFixture();
  const unblock = blockPersonalExport(f.store);
  try {
    f.store.put("personal", "one", {
      id: "one",
      version: 1,
      notes: "committed",
    });
    f.store.autoExport();
    assert.throws(() => f.store.flushExport(), /EISDIR|EPERM/);
    unblock();
    t.mock.timers.tick(2000);
    assert.equal(
      snapshot(f.store.dataDir).records.personal[0].notes,
      "committed",
    );
  } finally {
    unblock();
    f.cleanup();
  }
});

test("shutdown suppresses retries before a failed final flush closes SQLite", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
  t.mock.method(console, "error", () => {});
  const f = applicationAnswerFixture();
  blockPersonalExport(f.store);
  const flush = f.store.flushExport.bind(f.store);
  let attempts = 0;
  t.mock.method(f.store, "flushExport", () => {
    attempts++;
    return flush();
  });
  try {
    f.store.autoExport();
    assert.throws(() => f.store.close(), /EISDIR|EPERM/);
    t.mock.timers.tick(600000);
    assert.equal(attempts, 1);
    assert.throws(() => f.store.list("personal"), /closed|not open/i);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
