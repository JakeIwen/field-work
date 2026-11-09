import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createStateRefreshCadence } from "./state-refresh-cadence";

class Visibility extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  change(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

async function settle() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(t: TestContext, load: () => Promise<void> = async () => {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const visibility = new Visibility();
  const starts: number[] = [];
  const cadence = createStateRefreshCadence(async () => {
    starts.push(Date.now());
    await load();
  }, visibility);
  let stop = cadence.observe();
  t.after(() => stop());
  const tick = async (ms: number) => { t.mock.timers.tick(ms); await settle(); };
  return { ...cadence, starts, visibility, tick, stop: () => stop(), restart: () => { stop = cadence.observe(); } };
}

test("an isolated invalidation waits 750 ms and coalesces the pending burst", async t => {
  const f = fixture(t);
  f.invalidate();
  await f.tick(300);
  f.invalidate();
  await f.tick(449);
  assert.deepEqual(f.starts, []);
  await f.tick(1);
  assert.deepEqual(f.starts, [750]);
  await f.tick(5000);
  assert.deepEqual(f.starts, [750]);
});

test("continuous invalidations do not starve refreshes or start them less than 3 s apart", async t => {
  const f = fixture(t);
  for (let i = 0; i < 64; i++) {
    f.invalidate();
    await f.tick(125);
  }
  assert.deepEqual(f.starts, [750, 3750, 6750]);
});

test("a fresh invalidation after a quiet period retains the 750 ms window", async t => {
  const f = fixture(t);
  f.invalidate();
  await f.tick(750);
  await f.tick(9250);
  f.invalidate();
  await f.tick(749);
  assert.deepEqual(f.starts, [750]);
  await f.tick(1);
  assert.deepEqual(f.starts, [750, 10750]);
});

test("hidden invalidations only mark stale and becoming visible refreshes once", async t => {
  const f = fixture(t);
  f.visibility.change("hidden");
  for (let i = 0; i < 10; i++) {
    f.invalidate();
    await f.tick(1000);
  }
  assert.deepEqual(f.starts, []);
  f.visibility.change("visible");
  await f.tick(0);
  assert.deepEqual(f.starts, [10000]);
  f.visibility.change("hidden");
  f.visibility.change("visible");
  await f.tick(10000);
  assert.deepEqual(f.starts, [10000]);
});

test("hiding cancels an already scheduled refresh without losing its invalidation", async t => {
  const f = fixture(t);
  f.invalidate();
  await f.tick(100);
  f.visibility.change("hidden");
  await f.tick(5000);
  assert.deepEqual(f.starts, []);
  f.visibility.change("visible");
  await f.tick(0);
  assert.deepEqual(f.starts, [5100]);
});

test("a short hidden interval does not bypass the event-driven start-to-start floor", async t => {
  const f = fixture(t);
  f.invalidate();
  await f.tick(750);
  f.visibility.change("hidden");
  f.invalidate();
  await f.tick(100);
  f.visibility.change("visible");
  await f.tick(2899);
  assert.deepEqual(f.starts, [750]);
  await f.tick(1);
  assert.deepEqual(f.starts, [750, 3750]);
});

test("explicit initial, reconnect and mutation reads stay immediate even while hidden", async t => {
  const f = fixture(t);
  f.visibility.change("hidden");
  for (let i = 0; i < 3; i++) {
    f.invalidate();
    await f.reload();
    await f.tick(100);
  }
  assert.deepEqual(f.starts, [0, 100, 200]);
  f.visibility.change("visible");
  await f.tick(5000);
  assert.deepEqual(f.starts, [0, 100, 200]);
});

test("explicit reads supersede pending events and space later events from their actual start", async t => {
  const f = fixture(t);
  await f.reload();
  f.invalidate();
  await f.tick(500);
  await f.reload();
  await f.tick(1000);
  assert.deepEqual(f.starts, [0, 500]);
  f.invalidate();
  await f.tick(1999);
  assert.deepEqual(f.starts, [0, 500]);
  await f.tick(1);
  assert.deepEqual(f.starts, [0, 500, 3500]);
});

test("queued explicit reads still get a fresh single-flight response and set the real cadence", async t => {
  const first = deferred(), second = deferred();
  const pending = [first, second];
  const f = fixture(t, () => pending.shift()?.promise ?? Promise.resolve());
  const initial = f.reload();
  f.invalidate();
  await f.tick(100);
  let settled = 0;
  const mutation = f.reload().then(() => { settled++; });
  const reconnect = f.reload().then(() => { settled++; });
  await f.tick(3900);
  assert.deepEqual(f.starts, [0]);
  first.resolve();
  await initial;
  assert.deepEqual(f.starts, [0, 4000]);
  assert.equal(settled, 0);
  await f.tick(50);
  f.invalidate();
  second.resolve();
  await Promise.all([mutation, reconnect]);
  assert.equal(settled, 2);
  await f.tick(2949);
  assert.deepEqual(f.starts, [0, 4000]);
  await f.tick(1);
  assert.deepEqual(f.starts, [0, 4000, 7000]);
});

test("events during a slow read wait for it to settle, preserving one trailing refresh", async t => {
  const slow = deferred();
  let first = true;
  const f = fixture(t, () => { if (first) { first = false; return slow.promise; } return Promise.resolve(); });
  f.invalidate();
  await f.tick(750);
  f.invalidate();
  await f.tick(4000);
  assert.deepEqual(f.starts, [750]);
  slow.resolve();
  await settle();
  await f.tick(0);
  assert.deepEqual(f.starts, [750, 4750]);
  await f.tick(10000);
  assert.deepEqual(f.starts, [750, 4750]);
});

test("cleanup cancels scheduled work and visibility listeners, and can be observed again", async t => {
  const f = fixture(t);
  f.invalidate();
  f.stop();
  f.visibility.change("hidden");
  f.visibility.change("visible");
  await f.tick(5000);
  assert.deepEqual(f.starts, []);
  f.restart();
  await f.tick(0);
  assert.deepEqual(f.starts, [5000]);
});

test("cleanup also prevents a settled in-flight read from scheduling more work", async t => {
  const slow = deferred();
  const f = fixture(t, () => slow.promise);
  const initial = f.reload();
  f.invalidate();
  f.stop();
  slow.resolve();
  await initial;
  await f.tick(10000);
  assert.deepEqual(f.starts, [0]);
});

test("failed reads retain explicit rejection and later invalidations can recover", async t => {
  let failed = true;
  const f = fixture(t, async () => { if (failed) throw new Error("offline"); });
  await assert.rejects(f.reload(), /offline/);
  f.invalidate();
  await f.tick(3000);
  assert.deepEqual(f.starts, [0, 3000]);
  failed = false;
  f.invalidate();
  await f.tick(3000);
  assert.deepEqual(f.starts, [0, 3000, 6000]);
});

test("event refresh spacing follows updated values without rebuilding the cadence", async t => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const visibility = new Visibility();
  const starts: number[] = [];
  const timing = { coalesceMs: 100, minIntervalMs: 5000 };
  const cadence = createStateRefreshCadence(async () => { starts.push(Date.now()); }, visibility, () => timing);
  const stop = cadence.observe();
  t.after(stop);
  cadence.invalidate();
  t.mock.timers.tick(100); await settle();
  assert.deepEqual(starts, [100]);
  cadence.invalidate();
  t.mock.timers.tick(4999); await settle();
  assert.deepEqual(starts, [100]);
  t.mock.timers.tick(1); await settle();
  assert.deepEqual(starts, [100, 5100]);
  timing.minIntervalMs = 1000;
  cadence.invalidate();
  t.mock.timers.tick(1000); await settle();
  assert.deepEqual(starts, [100, 5100, 6100]);
});
