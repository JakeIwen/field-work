import test from "node:test";
import assert from "node:assert/strict";
import { applicationAnswerFixture } from "./fixtures/application-answers-fixture.js";
import { blockPersonalExport } from "./fixtures/export-writer.js";

test("persistent export failures back off to five minutes independently of normal mutations", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
  t.mock.method(console, "error", () => {});
  const f = applicationAnswerFixture();
  const unblock = blockPersonalExport(f.store);
  const original = f.store.flushExport.bind(f.store);
  let attempts = 0;
  t.mock.method(f.store, "flushExport", () => {
    attempts++;
    return original();
  });
  try {
    f.store.autoExport();
    t.mock.timers.tick(2000);
    assert.equal(attempts, 1);
    for (const delay of [
      2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000, 300000,
    ]) {
      const before: number = attempts;
      f.store.put("personal", "one", { id: "one", version: before });
      f.store.autoExport();
      t.mock.timers.tick(delay - 1);
      assert.equal(
        attempts,
        before,
        `retry must wait ${delay} ms despite mutation`,
      );
      f.store.autoExport();
      t.mock.timers.tick(1);
      assert.equal(
        attempts,
        before + 1,
        "mutation must not postpone an armed retry",
      );
    }
    unblock();
    t.mock.timers.tick(300000);
    const recovered = attempts;
    f.store.put("personal", "one", { id: "one", version: 99 });
    f.store.autoExport();
    t.mock.timers.tick(599999);
    assert.equal(attempts, recovered);
    t.mock.timers.tick(1);
    assert.equal(
      attempts,
      recovered + 1,
      "successful export restores the ten-minute interval",
    );
  } finally {
    unblock();
    f.cleanup();
  }
});

test("persistent export diagnostics are rate limited even for forced explicit failures", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1791600000000 });
  const messages: number[] = [];
  t.mock.method(console, "error", () => {
    messages.push(Date.now());
  });
  const f = applicationAnswerFixture();
  const unblock = blockPersonalExport(f.store);
  try {
    for (let i = 0; i < 20; i++)
      assert.throws(() => f.store.flushExport(), /EISDIR|EPERM/);
    assert.equal(messages.length, 1);
    t.mock.timers.tick(60000);
    assert.throws(() => f.store.flushExport(), /EISDIR|EPERM/);
    assert.equal(messages.length, 2);
    assert.ok(messages[1] - messages[0] >= 60000);
  } finally {
    unblock();
    f.cleanup();
  }
});
