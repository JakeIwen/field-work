import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { setImmediate } from "node:timers/promises";
import express from "express";
import type { WorkspaceContext } from "../server/server.js";
import { register } from "../server/routes/greenhouse.js";
import {
  searchUrl,
  type GreenhouseSource,
} from "../server/greenhouse-source.js";
import { GreenhousePullLoop } from "../server/greenhouse-pull-loop.js";
import { greenhouseParallelReviewBounds } from "../shared/greenhouse-pull.js";
import {
  fixture,
  advanceUntil,
  at,
  card,
} from "./fixtures/greenhouse-pull-fixture.js";

const running = (f: ReturnType<typeof fixture>) =>
  f.store.list("task").filter((task) => task.status === "running");

async function settingsFixture(source: Partial<GreenhouseSource> = {}) {
  const f = fixture(
    {
      page: async (query, page, employmentTypes) => ({
        query,
        page,
        employmentTypes,
        cards: Array.from({ length: 16 }, (_, index) =>
          card(String(index + 1)),
        ),
        more: true,
        url: searchUrl(query, page, employmentTypes),
        at: new Date(at).toISOString(),
        status: 200,
      }),
      ...source,
    },
    { autoStart: true },
  );
  const app = express();
  app.use(express.json());
  register(
    app,
    {
      store: f.store,
      greenhousePull: f.manager,
      version: (value: unknown) => Number(value),
      changed: (res, value) => {
        res.json(value);
      },
    } as WorkspaceContext,
    "start",
  );
  const server = createServer(app).listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    ...f,
    post: (route: string, parallelReviews: number) =>
      fetch(`http://127.0.0.1:${address.port}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedVersion: f.store.settings().version,
          parallelReviews,
          pacingRate: 2000,
          searchLookahead: 16,
        }),
      }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await f.close();
    },
  };
}

async function advanceClockUntil(
  t: TestContext,
  ready: () => boolean,
  max = 20000,
) {
  const started = Date.now();
  for (let elapsed = 0; elapsed <= max; elapsed += 250) {
    await setImmediate();
    if (ready()) return Date.now() - started;
    t.mock.timers.tick(250);
  }
  assert.fail(`Reviews did not start within ${max} ms`);
}

for (const route of [
  "/api/greenhouse/pull-settings",
  "/api/greenhouse/parallel-reviews",
]) {
  test(`${route} fills an increased live review limit within three seconds`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: at });
    const f = await settingsFixture();
    try {
      f.store.put("settings", "main", {
        ...f.store.settings(),
        parallelReviews: 1,
      });
      f.manager.start(100);
      await advanceUntil(f, () => running(f).length === 1);
      const savedAt = Date.now();
      assert.equal((await f.post(route, 8)).status, 200);
      await advanceClockUntil(t, () => running(f).length === 8);
      const delay = Date.now() - savedAt;
      t.diagnostic(
        `save-to-eight-running: ${delay} ms (virtual timer; fake source and agent)`,
      );
      assert.ok(
        delay <= 3000,
        `Additional reviews took ${delay} ms after saving`,
      );
    } finally {
      await f.close();
    }
  });
}

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function elapse(t: TestContext, milliseconds: number) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 250) {
    t.mock.timers.tick(250);
    await setImmediate();
  }
}

test("in-flight search blocks even a queued review start and stays serialized with posting retrieval", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: at });
  const gate = barrier();
  let pages = 0;
  const f = await settingsFixture({
    page: async (query, page, employmentTypes) => {
      if (++pages > 1) await gate.promise;
      return {
        query,
        page,
        employmentTypes,
        cards:
          pages === 1
            ? Array.from({ length: 16 }, (_, index) => card(String(index + 1)))
            : [],
        more: pages === 1,
        url: searchUrl(query, page, employmentTypes),
        at: new Date(at).toISOString(),
        status: 200,
      };
    },
  });
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      parallelReviews: 2,
      greenhouseSearchLookahead: 40,
    });
    f.manager.start(100);
    await advanceUntil(f, () => running(f).length === 1);
    await f.manager.tick();
    assert.equal(
      f.store.list("task").filter((task) => task.status === "handoff").length,
      1,
    );
    f.store.put("settings", "main", {
      ...f.store.settings(),
      parallelReviews: 1,
    });
    const search = f.manager.tick();
    assert.equal(pages, 2);
    const savedAt = Date.now();
    assert.equal(
      (await f.post("/api/greenhouse/pull-settings", 8)).status,
      200,
    );
    await elapse(t, 10000);
    assert.equal(running(f).length, 1);
    assert.equal(f.calls.filter((call) => call.posting).length, 2);
    gate.release();
    await search;
    await advanceClockUntil(t, () => running(f).length === 8, 3000);
    t.diagnostic(
      `blocked-search save-to-eight-running: ${Date.now() - savedAt} ms (search held 10000 ms)`,
    );
  } finally {
    gate.release();
    await f.close();
  }
});

for (const route of [
  "/api/greenhouse/pull-settings",
  "/api/greenhouse/parallel-reviews",
]) {
  test(`${route} decrease during creation leaves queued tasks waiting and still publishes completions`, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval", "Date"], now: at });
    const f = await settingsFixture();
    const gate = barrier();
    const creating = barrier();
    try {
      f.store.put("settings", "main", {
        ...f.store.settings(),
        parallelReviews: 1,
      });
      f.manager.start(100);
      await advanceUntil(f, () => running(f).length === 1);
      const create = f.review.createResearch;
      f.review.createResearch = async (run, candidate) => {
        const task = await create(run, candidate);
        creating.release();
        await gate.promise;
        return task;
      };
      assert.equal((await f.post(route, 8)).status, 200);
      await creating.promise;
      assert.equal((await f.post(route, 1)).status, 200);
      gate.release();
      await elapse(t, 2000);
      assert.equal(running(f).length, 1);
      assert.equal(f.store.list("task").length, 2);
      assert.equal(
        f.store.list("task").find((task) => task.status === "handoff")
          ?.threadId,
        undefined,
      );
      f.finish();
      await advanceClockUntil(
        t,
        () => f.manager.state()?.added === 1 && running(f).length === 1,
        3000,
      );
      assert.equal(f.store.list("task").length, 2);
      assert.equal(f.calls.filter((call) => call.interrupt).length, 0);
    } finally {
      gate.release();
      await f.close();
    }
  });
}

test("review wake is single-flight and bounded even when steps make no progress", async () => {
  const gate = barrier();
  let steps = 0;
  const loop = new GreenhousePullLoop(async () => {
    steps++;
    await gate.promise;
    return true;
  }, false);
  loop.wake();
  loop.wake();
  assert.equal(steps, 1);
  gate.release();
  await setImmediate();
  assert.equal(steps, greenhouseParallelReviewBounds.max * 2);
  await loop.close();
  loop.wake();
  await setImmediate();
  assert.equal(steps, greenhouseParallelReviewBounds.max * 2);
});
