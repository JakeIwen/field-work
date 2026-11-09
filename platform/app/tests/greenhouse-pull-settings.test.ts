import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import {
  fixture,
  advanceUntil,
  at,
  card,
} from "./fixtures/greenhouse-pull-fixture.js";
import { searchUrl } from "../server/greenhouse-source.js";

const endpoint = "/api/greenhouse/pull-settings";
const settingsValues = {
  pacingRate: 2000,
  parallelReviews: 6,
  searchLookahead: 6,
};

test("combined pull settings reject invalid fields without partial writes and reject stale versions", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "greenhouse-pull-settings-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    const old = workspace.store.settings();
    const invalid = {
      pacingRate: [null, "2000", 999, 60001, 1000.5, true, [], undefined],
      parallelReviews: [null, "6", 0, 11, 1.5, true, [], undefined],
      searchLookahead: [null, "6", 0, 41, 1.5, true, [], undefined],
      pacingPenaltyMs: [
        null,
        "1000",
        -1,
        0.5,
        true,
        [],
        Number.MAX_SAFE_INTEGER + 1,
      ],
    };
    for (const [field, values] of Object.entries(invalid)) {
      for (const value of values) {
        const response = await workspace.post(endpoint, {
          expectedVersion: old.version,
          ...settingsValues,
          [field]: value,
        });
        assert.equal(response.status, 400, `${field}: ${String(value)}`);
        assert.deepEqual(workspace.store.settings(), old);
      }
    }
    assert.equal(
      (
        await workspace.post(endpoint, {
          expectedVersion: old.version - 1,
          ...settingsValues,
        })
      ).status,
      409,
    );
    assert.deepEqual(workspace.store.settings(), old);
    assert.equal(workspace.store.list("greenhouse_pull_run").length, 0);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("combined pull settings save once, persist privately and preserve legacy routes", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "greenhouse-pull-settings-"));
  let workspace = await openFixtureWorkspace(root);
  try {
    for (const values of [
      { pacingRate: 1000, parallelReviews: 1, searchLookahead: 40 },
      { pacingRate: 60000, parallelReviews: 10, searchLookahead: 1 },
    ]) {
      const old = workspace.store.settings();
      const response = await workspace.post(endpoint, {
        expectedVersion: old.version,
        ...values,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ...old,
        greenhousePacingRate: values.pacingRate,
        parallelReviews: values.parallelReviews,
        greenhouseSearchLookahead: values.searchLookahead,
        version: old.version + 1,
      });
      assert.equal(
        (
          await workspace.post(endpoint, {
            expectedVersion: old.version,
            ...values,
          })
        ).status,
        409,
      );
    }
    for (const [route, value] of [
      ["pacing", { pacingRate: 3000 }],
      ["parallel-reviews", { parallelReviews: 8 }],
    ] as const) {
      const response = await workspace.post(`/api/greenhouse/${route}`, {
        expectedVersion: workspace.store.settings().version,
        ...value,
      });
      assert.equal(response.status, 200);
      assert.equal(workspace.store.settings().greenhouseSearchLookahead, 1);
    }
    const saved = workspace.store.settings();
    assert.equal(workspace.store.list("greenhouse_pull_run").length, 0);
    assert.deepEqual(
      workspace.store.personalExport().records.settings[0],
      saved,
    );
    await workspace.close();
    workspace = await openFixtureWorkspace(root);
    const state = await (await workspace.get("/api/state")).json();
    assert.deepEqual(state.settings, saved);
    assert.equal(state.greenhousePull, null);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("combined settings persist and clear adaptive delay without changing the floor or losing version checks", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "greenhouse-pull-settings-"));
  let workspace = await openFixtureWorkspace(root);
  try {
    let version = workspace.store.settings().version;
    const save = (pacingPenaltyMs?: number) =>
      workspace.post(endpoint, {
        expectedVersion: version,
        ...settingsValues,
        ...(pacingPenaltyMs === undefined ? {} : { pacingPenaltyMs }),
      });
    assert.equal((await save(1500)).status, 200);
    assert.equal(workspace.store.settings().greenhousePacingRate, 2000);
    assert.equal(workspace.store.settings().greenhousePacingPenaltyMs, 1500);
    assert.equal(
      (await save(0)).status,
      409,
      "a stale clear cannot discard a newer adaptive change",
    );
    version = workspace.store.settings().version;
    assert.equal((await save()).status, 200);
    assert.equal(
      workspace.store.settings().greenhousePacingPenaltyMs,
      1500,
      "ordinary saves preserve the penalty",
    );
    await workspace.close();
    workspace = await openFixtureWorkspace(root);
    assert.equal(workspace.store.settings().greenhousePacingPenaltyMs, 1500);
    version = workspace.store.settings().version;
    assert.equal((await save(0)).status, 200);
    const saved = workspace.store.settings();
    assert.equal(saved.greenhousePacingPenaltyMs, 0);
    assert.equal(saved.greenhousePacingRate, 2000);
    assert.equal(saved.version, version + 1);
    assert.equal(
      workspace.store.personalExport().records.settings[0]
        .greenhousePacingPenaltyMs,
      0,
    );
    assert.equal(workspace.store.list("greenhouse_pull_run").length, 0);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [parallelReviews, searchLookahead] of [
  [6, 2],
  [2, 8],
]) {
  test(`lookahead ${searchLookahead} controls queued discovery independently of ${parallelReviews} reviews`, async () => {
    const size = parallelReviews + searchLookahead;
    const f = fixture({
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
    const running = () =>
      f.store.list("task").filter((task) => task.status === "running").length;
    try {
      f.store.put("settings", "main", {
        ...f.store.settings(),
        parallelReviews,
        greenhouseSearchLookahead: searchLookahead,
      });
      const run = f.manager.start(100);
      await advanceUntil(f, () => running() === parallelReviews);
      for (let i = 0; i < 4; i++) await f.manager.tick();
      assert.equal(
        f.manager.ledger(run.id).run.pages.length,
        1,
        "queue at lookahead blocks a page",
      );
      assert.equal(f.manager.state()!.searchLookahead, searchLookahead);
      assert.deepEqual(f.manager.ledger(run.id).run.searchLookaheadChanges, [
        { at: new Date(at).toISOString(), searchLookahead },
      ]);
      f.finish(true);
      await advanceUntil(
        f,
        () => f.store.list("task").length === parallelReviews + 1,
      );
      await advanceUntil(
        f,
        () => f.manager.ledger(run.id).run.pages.length === 2,
      );
      assert.equal(
        running(),
        parallelReviews,
        "lookahead never changes review concurrency",
      );
      f.setTime(at + 1000);
      f.store.put("settings", "main", {
        ...f.store.settings(),
        greenhouseSearchLookahead: 40,
      });
      await advanceUntil(
        f,
        () => f.manager.ledger(run.id).run.pages.length === 3,
      );
      assert.equal(running(), parallelReviews);
      assert.equal(f.manager.state()!.searchLookahead, 40);
      assert.deepEqual(f.manager.ledger(run.id).run.searchLookaheadChanges, [
        { at: new Date(at).toISOString(), searchLookahead },
        { at: new Date(at + 1000).toISOString(), searchLookahead: 40 },
      ]);
      assert.equal(
        f.manager.ledger(run.id).run.parallelReviewChanges!.length,
        1,
      );
      await f.restart();
      assert.equal(f.manager.state()!.searchLookahead, 40);
    } finally {
      await f.close();
    }
  });
}

test("combined pull settings round-trip the form-check boolean, reject other types and keep it when omitted", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "greenhouse-pull-settings-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    assert.equal(
      workspace.store.settings().greenhouseFormCheckNewOpenings,
      undefined,
    );
    for (const value of ["true", 1, null, []]) {
      const old = workspace.store.settings();
      const response = await workspace.post(endpoint, {
        expectedVersion: old.version,
        ...settingsValues,
        formCheckNewOpenings: value,
      });
      assert.equal(response.status, 400, String(value));
      assert.deepEqual(workspace.store.settings(), old);
    }
    for (const value of [false, true]) {
      const response = await workspace.post(endpoint, {
        expectedVersion: workspace.store.settings().version,
        ...settingsValues,
        formCheckNewOpenings: value,
      });
      assert.equal(response.status, 200);
      assert.equal(
        workspace.store.settings().greenhouseFormCheckNewOpenings,
        value,
      );
      assert.equal(
        (await (await workspace.get("/api/state")).json()).settings
          .greenhouseFormCheckNewOpenings,
        value,
      );
    }
    await workspace.post(endpoint, {
      expectedVersion: workspace.store.settings().version,
      ...settingsValues,
      formCheckNewOpenings: false,
    });
    await workspace.post(endpoint, {
      expectedVersion: workspace.store.settings().version,
      ...settingsValues,
    });
    assert.equal(
      workspace.store.settings().greenhouseFormCheckNewOpenings,
      false,
    );
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});
