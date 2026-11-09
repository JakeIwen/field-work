import test from "node:test";
import assert from "node:assert/strict";
import { reloadApp } from "./reload-app";

test("reload waits through downtime and requires a different ready backend before refreshing the page", async () => {
  let time = 0, probes = 0, refreshed = 0;
  await reloadApp({ request: async () => ({ reloading: true, pid: 10 }),
    health: async () => { probes++; if (probes === 1) throw new Error("offline"); return { status: "ok", pid: probes < 3 ? 10 : 11, reloading: probes === 3 }; },
    now: () => time, wait: async () => { time += 1000; }, reloadPage: () => { refreshed++; },
  });
  assert.equal(probes, 4); assert.equal(refreshed, 1);
});

test("reload timeout and request failure preserve the page and remain recoverable", async () => {
  let time = 0, probes = 0;
  const actions = { request: async () => ({ reloading: true as const, pid: 10 }), health: async () => { probes++; return { status: "ok", pid: 10 }; }, now: () => time, wait: async () => { time += 60000; }, reloadPage: () => assert.fail("must not reload") };
  await assert.rejects(() => reloadApp(actions), /three minutes/);
  assert.equal(probes, 3);
  await assert.rejects(() => reloadApp({ ...actions, request: async () => { throw new Error("Denied"); } }), /Denied/);
  await assert.rejects(() => reloadApp({ ...actions, request: async () => ({ reloading: true, pid: 0 }) }), /acknowledge/);
});

test("idle reload can wait longer than three minutes and publishes the remaining work", async () => {
  let time = 0, probes = 0, refreshed = 0;
  const counts: number[] = [];
  await reloadApp({ request: async whenIdle => { assert.equal(whenIdle, true); return { reloading: false, waiting: true, pid: 10 }; },
    health: async () => { probes++; return { status: 'ok', pid: probes < 6 ? 10 : 11, reloading: probes === 5,
      reload: { pid: 10, reloading: probes === 5, waiting: probes < 5, remaining: probes < 5 ? [{ id: 'work', label: 'Writing answers', detail: String(probes) }] : [] } }; },
    now: () => time, wait: async () => { time += 60000; }, reloadPage: () => { refreshed++; }, onStatus: status => counts.push(status.remaining.length),
  }, true);
  assert.equal(refreshed, 1); assert.ok(time > 180000); assert.deepEqual(counts, [1, 1, 1, 1, 0]);
});

test("cancelling an idle reload leaves the current page open", async () => {
  await reloadApp({ request: async () => ({ reloading: false, waiting: true, pid: 10 }),
    health: async () => ({ status: 'ok', pid: 10, reload: { pid: 10, reloading: false, waiting: false, remaining: [] } }),
    now: () => 0, wait: async () => {}, reloadPage: () => assert.fail('Cancellation must not reload the page'),
  }, true);
});
