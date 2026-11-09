import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fixture,
  advanceUntil,
  at,
  card,
} from "./fixtures/greenhouse-pull-fixture.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { searchUrl } from "../server/greenhouse-source.js";

type Fixture = ReturnType<typeof fixture>;
const running = (f: Fixture) =>
  f.store.list("task").filter((task) => task.status === "running");
function setParallelReviews(f: Fixture, parallelReviews: number) {
  const settings = f.store.settings();
  f.store.put("settings", "main", {
    ...settings,
    parallelReviews,
    version: settings.version + 1,
  });
}
function backlogFixture(size: number) {
  return fixture({
    page: async (query, page, employmentTypes) => ({
      query,
      page,
      employmentTypes,
      cards: Array.from({ length: size }, (_, index) =>
        card(String(index + 1)),
      ),
      more: true,
      url: searchUrl(query, page, employmentTypes),
      at: new Date(at).toISOString(),
      status: 200,
    }),
  });
}
async function ticks(f: Fixture, count: number) {
  for (let i = 0; i < count; i++) await f.manager.tick();
}

test("parallel review API validates whole bounds, versions and persistence without starting a pull", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "greenhouse-parallel-"));
  let workspace = await openFixtureWorkspace(root);
  try {
    const initial = workspace.store.settings();
    assert.equal(initial.parallelReviews, undefined);
    for (const parallelReviews of [
      null,
      "6",
      0,
      11,
      1.5,
      true,
      [],
      undefined,
    ]) {
      const response = await workspace.post(
        "/api/greenhouse/parallel-reviews",
        {
          expectedVersion: initial.version,
          parallelReviews,
        },
      );
      assert.equal(response.status, 400);
      assert.equal(workspace.store.settings().version, initial.version);
    }
    for (const parallelReviews of [1, 10]) {
      const old = workspace.store.settings();
      const response = await workspace.post(
        "/api/greenhouse/parallel-reviews",
        {
          expectedVersion: old.version,
          parallelReviews,
        },
      );
      assert.equal(response.status, 200);
      const saved = await response.json();
      assert.equal(saved.parallelReviews, parallelReviews);
      assert.equal(saved.version, old.version + 1);
      assert.deepEqual(saved, {
        ...old,
        parallelReviews,
        version: old.version + 1,
      });
    }
    assert.equal(
      (
        await workspace.post("/api/greenhouse/parallel-reviews", {
          expectedVersion: initial.version,
          parallelReviews: 6,
        })
      ).status,
      409,
    );
    assert.equal(workspace.store.list("greenhouse_pull_run").length, 0);
    assert.equal(
      workspace.store.personalExport().records.settings[0].parallelReviews,
      10,
    );
    await workspace.close();
    workspace = await openFixtureWorkspace(root);
    const state = await (await workspace.get("/api/state")).json();
    assert.equal(state.settings.parallelReviews, 10);
    assert.equal(state.greenhousePull, null);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const limit of [1, 10, undefined]) {
  test(`scheduler honors ${limit ?? "legacy default 6"} parallel reviews and records the used value`, async () => {
    const f = backlogFixture(24);
    try {
      if (limit !== undefined) setParallelReviews(f, limit);
      const expected = limit ?? 6;
      const run = f.manager.start(100);
      await advanceUntil(f, () => running(f).length === expected);
      await ticks(f, 5);
      assert.equal(running(f).length, expected);
      assert.equal(f.store.list("task").length, expected);
      assert.equal(f.manager.state()!.parallelReviews, expected);
      assert.equal(f.manager.state()!.searchLookahead, expected);
      assert.deepEqual(f.manager.ledger(run.id).run.searchLookaheadChanges, [
        { at: new Date(at).toISOString(), searchLookahead: expected },
      ]);
      assert.deepEqual(f.manager.ledger(run.id).run.parallelReviewChanges, [
        { at: new Date(at).toISOString(), parallelReviews: expected },
      ]);
    } finally {
      await f.close();
    }
  });
}

for (const limit of [1, 10]) {
  test(`discovery refills only below the live low-water of ${limit}`, async () => {
    const f = backlogFixture(limit * 2);
    try {
      setParallelReviews(f, limit);
      const run = f.manager.start(100);
      await advanceUntil(f, () => running(f).length === limit);
      await ticks(f, 4);
      assert.equal(
        f.manager.ledger(run.id).run.pages.length,
        1,
        "a full queued batch prevents another page",
      );
      f.finish(true);
      await advanceUntil(f, () => f.store.list("task").length === limit + 1);
      await advanceUntil(
        f,
        () => f.manager.ledger(run.id).run.pages.length === 2,
      );
      assert.equal(running(f).length, limit);
    } finally {
      await f.close();
    }
  });
}

test("lowering a searching run stops new starts without interrupting reviews, and updates low-water live", async () => {
  const f = backlogFixture(12);
  try {
    setParallelReviews(f, 6);
    const run = f.manager.start(100);
    await advanceUntil(f, () => running(f).length === 6);
    setParallelReviews(f, 1);
    f.setTime(at + 1000);
    await ticks(f, 5);
    assert.equal(running(f).length, 6);
    assert.equal(f.store.list("task").length, 6);
    assert.equal(f.manager.ledger(run.id).run.pages.length, 1);
    assert.equal(f.calls.filter((call) => call.interrupt).length, 0);
    for (let i = 1; i <= 5; i++) f.finish(true, String(i));
    await ticks(f, 7);
    assert.equal(running(f).length, 1);
    assert.equal(f.store.list("task").length, 6);
    f.finish(true, "6");
    await advanceUntil(f, () => f.store.list("task").length === 7);
    await ticks(f, 3);
    assert.equal(running(f).length, 1);
    assert.equal(
      f.manager.ledger(run.id).run.pages.length,
      1,
      "five queued candidates stay above the lowered low-water",
    );
    setParallelReviews(f, 10);
    f.setTime(at + 2000);
    await advanceUntil(
      f,
      () => f.manager.ledger(run.id).run.pages.length === 2,
    );
    assert.equal(running(f).length, 6);
    assert.deepEqual(
      f.manager
        .ledger(run.id)
        .run.parallelReviewChanges?.map((use) => use.parallelReviews),
      [6, 1, 10],
    );
    assert.deepEqual(
      f.manager
        .ledger(run.id)
        .run.searchLookaheadChanges?.map((use) => use.searchLookahead),
      [6, 1, 10],
    );
    assert.equal(
      f.store.personalExport().records.greenhouse_pull_run[0].parallelReviews,
      10,
    );
  } finally {
    await f.close();
  }
});

test("a limit lowered between task creation and start waits for existing reviews", async () => {
  const f = backlogFixture(12);
  try {
    setParallelReviews(f, 10);
    f.manager.start(100);
    await advanceUntil(f, () => running(f).length === 1);
    await f.manager.tick();
    assert.equal(f.store.list("task").length, 2);
    setParallelReviews(f, 1);
    await ticks(f, 4);
    assert.equal(running(f).length, 1);
    assert.equal(
      f.store.list("task").filter((task) => task.status === "handoff").length,
      1,
    );
    f.finish(true);
    await advanceUntil(f, () => running(f).length === 1);
    assert.equal(f.store.list("task").length, 2);
    assert.equal(f.calls.filter((call) => call.interrupt).length, 0);
  } finally {
    await f.close();
  }
});

test("a higher parallel limit preserves the searching remaining-target reservation cap", async () => {
  const f = backlogFixture(24);
  try {
    setParallelReviews(f, 10);
    f.manager.start(2);
    await advanceUntil(f, () => running(f).length === 2);
    await ticks(f, 5);
    assert.equal(f.store.list("task").length, 2);
    f.finish();
    await ticks(f, 5);
    assert.equal(f.store.list("task").length, 2);
    assert.equal(f.manager.state()!.added, 1);
  } finally {
    await f.close();
  }
});

test("capacity retries wait for the lowered live limit instead of bypassing it", async () => {
  const f = backlogFixture(12);
  const create = f.review.createResearch;
  let attempts = 0;
  f.review.createResearch = async (run, candidate) => {
    if (++attempts === 2) throw Error("Selected model is at capacity");
    return create(run, candidate);
  };
  try {
    setParallelReviews(f, 10);
    const run = f.manager.start(100);
    await advanceUntil(f, () =>
      Boolean(f.manager.ledger(run.id).run.reviewCooldown),
    );
    assert.equal(running(f).length, 1);
    setParallelReviews(f, 1);
    f.setTime(at + 60000);
    await ticks(f, 4);
    assert.equal(attempts, 2);
    assert.equal(running(f).length, 1);
    f.finish(true);
    await advanceUntil(f, () => running(f).length === 1);
    assert.equal(attempts, 3);
    assert.equal(f.calls.filter((call) => call.interrupt).length, 0);
  } finally {
    await f.close();
  }
});

test("pull summary reads the effective live review limit without waiting for a scheduler step", async () => {
  const f = backlogFixture(12);
  try {
    setParallelReviews(f, 2);
    const run = f.manager.start(100);
    await f.manager.tick();
    assert.equal(f.manager.state()?.effectiveParallelReviews, 2);
    setParallelReviews(f, 8);
    assert.equal(f.manager.state()?.effectiveParallelReviews, 8);
    assert.equal(
      f.manager.state()?.parallelReviews,
      2,
      "retain the last-used historical limit",
    );
    f.manager.action(run.id, "pause");
    setParallelReviews(f, 1);
    assert.equal(f.manager.state()?.effectiveParallelReviews, 1);
    assert.equal(f.manager.ledger(run.id).run.parallelReviews, 2);
  } finally {
    await f.close();
  }
});

for (const reason of ["target", "stop"] as const) {
  test(`${reason} finishing reads live limits without the searching target cap`, async () => {
    const f = backlogFixture(12);
    try {
      setParallelReviews(f, 1);
      const run = f.manager.start(1);
      await advanceUntil(f, () => running(f).length === 1);
      if (reason === "target") {
        f.finish();
        await advanceUntil(f, () => f.manager.state()!.status === "finishing");
      } else f.manager.action(run.id, "stop");
      setParallelReviews(f, 10);
      await advanceUntil(f, () => running(f).length === 10);
      assert.equal(f.manager.ledger(run.id).run.pages.length, 1);
      setParallelReviews(f, 1);
      await ticks(f, 4);
      assert.equal(running(f).length, 10);
      const count = f.store.list("task").length;
      for (const task of running(f).slice(0, 9)) {
        const candidate = f.manager
          .ledger(run.id)
          .candidates.find((c) => c.taskId === task.id);
        assert.ok(candidate);
        f.finish(true, candidate.card.id);
      }
      await ticks(f, 12);
      assert.equal(running(f).length, 1);
      assert.equal(f.store.list("task").length, count);
      f.finish(true);
      await advanceUntil(f, () => f.store.list("task").length > count);
      assert.equal(f.calls.filter((call) => call.interrupt).length, 0);
      assert.deepEqual(
        f.manager
          .ledger(run.id)
          .run.parallelReviewChanges?.map((use) => use.parallelReviews),
        [1, 10, 1],
      );
      await f.restart();
      assert.deepEqual(
        f.manager
          .ledger(run.id)
          .run.parallelReviewChanges?.map((use) => use.parallelReviews),
        [1, 10, 1],
      );
    } finally {
      await f.close();
    }
  });
}
