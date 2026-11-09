import assert from "node:assert/strict";
import test from "node:test";
import { pollReloadStatus } from "./reload-status-poll";

class Visibility extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  change(value: DocumentVisibilityState) {
    this.visibilityState = value;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };

test("reload status polling pauses hidden tabs and reads once on visibility return", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visibility = new Visibility();
  visibility.visibilityState = "hidden";
  let calls = 0;
  const stop = pollReloadStatus(async () => { calls++; }, visibility);
  assert.equal(calls, 0);
  visibility.change("visible");
  await settle();
  assert.equal(calls, 1);
  t.mock.timers.tick(2500); await settle();
  assert.equal(calls, 2);
  visibility.change("hidden");
  t.mock.timers.tick(60_000); await settle();
  assert.equal(calls, 2);
  visibility.change("visible"); await settle();
  assert.equal(calls, 3);
  stop();
  visibility.change("hidden"); visibility.change("visible");
  t.mock.timers.tick(60_000); await settle();
  assert.equal(calls, 3);
});

test("reload status failures back off to thirty seconds and success resets the cadence", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0, failing = true;
  const stop = pollReloadStatus(async () => {
    calls++;
    if (failing) throw new Error("offline");
  }, new Visibility());
  await settle();
  assert.equal(calls, 1);
  for (const delay of [2500, 5000, 10_000, 20_000, 30_000, 30_000]) {
    const before: number = calls;
    t.mock.timers.tick(delay - 1); await settle();
    assert.equal(calls, before);
    t.mock.timers.tick(1); await settle();
    assert.equal(calls, before + 1);
  }
  failing = false;
  t.mock.timers.tick(30_000); await settle();
  const recovered = calls;
  t.mock.timers.tick(2499); await settle();
  assert.equal(calls, recovered);
  t.mock.timers.tick(1); await settle();
  assert.equal(calls, recovered + 1);
  stop();
});

test("visibility changes do not overlap reads and cleanup cannot restart pending polling", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const visibility = new Visibility();
  let calls = 0;
  let release = () => {};
  const stop = pollReloadStatus(() => {
    calls++;
    return new Promise<void>((resolve) => { release = resolve; });
  }, visibility);
  visibility.change("hidden"); visibility.change("visible");
  assert.equal(calls, 1);
  stop(); release(); await settle();
  t.mock.timers.tick(60_000); await settle();
  assert.equal(calls, 1);
});
