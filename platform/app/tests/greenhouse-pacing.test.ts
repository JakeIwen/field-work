import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fixture, at, card } from "./fixtures/greenhouse-pull-fixture.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { greenhouseBrowserFixture } from "./fixtures/greenhouse-browser.js";
import { advanceUntil } from "./fixtures/greenhouse-pull-fixture.js";
import { greenhouseBridgeFailureLimit } from "../server/greenhouse-pull-failures.js";
import {
  GreenhouseLimit,
  type GreenhousePageOptions,
} from "../server/greenhouse-source.js";
import {
  GreenhouseSearchTransient,
  searchUrl,
} from "../server/greenhouse-search.js";

function pacedFixture(error: Error) {
  let fail = true;
  const intervals: number[] = [];
  const f = fixture({
    page: async (
      query,
      page,
      employmentTypes,
      options?: GreenhousePageOptions,
    ) => {
      intervals.push(options!.pacingRate);
      if (fail) {
        fail = false;
        throw error;
      }
      return {
        query,
        page,
        employmentTypes,
        cards: [card("1")],
        more: false,
        status: 200,
        at: new Date(at).toISOString(),
        url: searchUrl(query, page, employmentTypes),
      };
    },
  });
  return { f, intervals };
}

test("search errors persist increased pacing, cooldown and exact interval history for this and the next run", async () => {
  for (const error of [
    new GreenhouseSearchTransient("Something went wrong"),
    new GreenhouseLimit("HTTP 429", new Date(at + 300000).toISOString()),
  ]) {
    const { f, intervals } = pacedFixture(error);
    try {
      const settings = { ...f.store.settings(), greenhousePacingRate: 2000 };
      f.store.put("settings", "main", settings);
      const run = f.manager.start();
      assert.equal(run.initialPacingRate, 2000);
      await f.manager.tick();
      const saved = f.manager.latest()!;
      assert.equal(saved.status, "cooldown");
      assert.equal(saved.pacingRate, 3000);
      assert.equal(saved.initialPacingRate, 2000);
      assert.deepEqual(saved.pacingIncreases, [
        {
          query: run.queryPlan![0].query,
          employmentTypes: run.queryPlan![0].employmentTypes,
          page: 1,
          at: new Date(at).toISOString(),
          error: String(error),
          from: 2000,
          to: 3000,
        },
      ]);
      assert.equal(f.store.settings().greenhousePacingRate, 2000);
      assert.equal(f.store.settings().greenhousePacingPenaltyMs, 1000);
      assert.equal(saved.pacingCleanPages, 0);
      assert.equal(f.store.settings().version, settings.version + 1);
      assert.equal(
        f.store.personalExport().records.settings[0].greenhousePacingPenaltyMs,
        1000,
      );
      await f.restart();
      f.manager.action(run.id, "resume");
      f.setTime(Date.parse(saved.retryAt!));
      await f.manager.tick();
      assert.deepEqual(intervals, [2000, 3000]);
      f.manager.action(run.id, "stop");
      assert.equal(f.manager.latest()!.finalPacingRate, undefined);
      assert.equal(f.manager.state()!.initialPacingRate, 2000);
      assert.equal(f.manager.state()!.pacingRate, 3000);
      const next = f.manager.start();
      assert.equal(next.initialPacingRate, 3000);
      assert.equal(next.pacingRate, 3000);
    } finally {
      await f.close();
    }
  }
});

test("ten recorded clean pages recover one step across restart, retain evidence and never cross the captured floor", async () => {
  const intervals: number[] = [];
  const f = fixture({
    page: async (query, page, employmentTypes, options) => {
      intervals.push(options!.pacingRate);
      return {
        query,
        page,
        employmentTypes,
        cards: [{ ...card(String(page)), title: "Account Executive" }],
        more: page < 31,
        status: 200,
        at: new Date(at).toISOString(),
        url: searchUrl(query, page, employmentTypes),
      };
    },
  });
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhousePacingRate: 3500,
      greenhousePacingPenaltyMs: 1500,
    });
    const run = f.manager.start(100);
    f.store.put("greenhouse_pull_run", run.id, {
      ...run,
      queryPlan: [run.queryPlan![0]],
    });
    await advanceUntil(f, () => f.manager.latest()!.pages.length === 9);
    assert.equal(f.manager.latest()!.pacingCleanPages, 9);
    assert.equal(f.manager.latest()!.pacingRate, 5000);
    assert.equal(f.manager.latest()!.pacingDecreases, undefined);
    await f.restart();
    assert.equal(f.manager.latest()!.pacingCleanPages, 9);
    f.manager.action(run.id, "resume");
    await advanceUntil(f, () => f.manager.latest()!.pages.length === 10);
    const recovered = f.manager.latest()!;
    assert.equal(recovered.pacingCleanPages, 0);
    assert.equal(recovered.pacingRate, 4000);
    assert.equal(
      recovered.pages[9].pacingRate,
      5000,
      "page evidence retains its actual request interval",
    );
    assert.equal(recovered.initialPacingRate, 5000);
    assert.deepEqual(recovered.pacingDecreases, [
      {
        query: run.queryPlan![0].query,
        employmentTypes: run.queryPlan![0].employmentTypes,
        at: new Date(at).toISOString(),
        page: 10,
        from: 5000,
        to: 4000,
      },
    ]);
    assert.ok(
      recovered.activity?.some(
        (entry) =>
          entry.level === "info" &&
          entry.text === "Page interval 5 s → 4 s after 10 clean pages",
      ),
    );
    assert.equal(f.store.settings().greenhousePacingPenaltyMs, 500);
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhousePacingRate: 1000,
    });
    await advanceUntil(f, () => f.manager.latest()!.status === "exhausted");
    const finished = f.manager.latest()!;
    assert.equal(
      finished.pacingRate,
      3500,
      "manual floor changes apply only to later runs",
    );
    assert.equal(finished.finalPacingRate, 3500);
    assert.deepEqual(
      finished.pacingDecreases?.map((change) => [change.from, change.to]),
      [
        [5000, 4000],
        [4000, 3500],
      ],
    );
    assert.equal(f.store.settings().greenhousePacingPenaltyMs, 0);
    assert.equal(f.store.settings().greenhousePacingRate, 1000);
    assert.deepEqual(intervals, [
      ...Array(10).fill(5000),
      ...Array(10).fill(4000),
      ...Array(11).fill(3500),
    ]);
    assert.equal(f.manager.start().initialPacingRate, 1000);
  } finally {
    await f.close();
  }
});

test("an increase resets the persisted clean-page streak before recovery can resume", async () => {
  let failed = false;
  const f = fixture({
    page: async (query, page, employmentTypes) => {
      if (page === 10 && !failed) {
        failed = true;
        throw new GreenhouseSearchTransient("Incomplete capture");
      }
      return {
        query,
        page,
        employmentTypes,
        cards: [{ ...card(String(page)), title: "Account Executive" }],
        more: true,
        status: 200,
        at: new Date(at).toISOString(),
        url: searchUrl(query, page, employmentTypes),
      };
    },
  });
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhousePacingRate: 2000,
      greenhousePacingPenaltyMs: 1000,
    });
    const run = f.manager.start(100);
    f.store.put("greenhouse_pull_run", run.id, {
      ...run,
      queryPlan: [run.queryPlan![0]],
    });
    await advanceUntil(f, () => f.manager.latest()!.pages.length === 9);
    assert.equal(f.manager.latest()!.pacingCleanPages, 9);
    await advanceUntil(f, () => f.manager.latest()!.status === "cooldown");
    const failedRun = f.manager.latest()!;
    assert.equal(failedRun.pacingCleanPages, 0);
    assert.equal(failedRun.pages.length, 9);
    assert.equal(failedRun.pacingRate, 4000);
    assert.equal(f.store.settings().greenhousePacingRate, 2000);
    assert.equal(f.store.settings().greenhousePacingPenaltyMs, 2000);
    await f.restart();
    f.manager.action(run.id, "resume");
    f.setTime(Date.parse(failedRun.retryAt!));
    await advanceUntil(f, () => f.manager.latest()!.pages.length === 18);
    assert.equal(f.manager.latest()!.pacingCleanPages, 9);
    assert.equal(f.manager.latest()!.pacingDecreases, undefined);
    await advanceUntil(f, () => f.manager.latest()!.pages.length === 19);
    assert.equal(f.manager.latest()!.pacingCleanPages, 0);
    assert.equal(f.manager.latest()!.pacingRate, 3000);
    assert.equal(f.store.settings().greenhousePacingPenaltyMs, 1000);
  } finally {
    await f.close();
  }
});

test("identity/schema/sign-in failures stop for attention without increasing pacing", async () => {
  for (const message of [
    "Sign in to MyGreenhouse",
    "Greenhouse search filters changed",
    "Greenhouse did not return the requested results page",
  ]) {
    const { f } = pacedFixture(Error(message));
    try {
      f.manager.start();
      await f.manager.tick();
      assert.equal(f.manager.state()!.status, "failed");
      assert.equal(f.manager.state()!.pacingRate, 2000);
      assert.equal(f.store.settings().greenhousePacingRate, undefined);
      assert.equal(f.manager.latest()!.pacingIncreases, undefined);
    } finally {
      await f.close();
    }
  }
});

test("bridge timeout retains the pending page, cooldown and pacing across restart and recreates a lost tab", async () => {
  let bodies = 0;
  const browser = greenhouseBrowserFixture({
    userscript: true,
    bridgeFailure: (command) =>
      command === "network_body" && ++bodies === 2
        ? new Response(
            JSON.stringify({ error: "Timeout waiting for content script" }),
          )
        : undefined,
  });
  const f = fixture({
    page: browser.source.page.bind(browser.source),
    cancelSearch: browser.source.cancelSearch.bind(browser.source),
  });
  try {
    const settings = f.store.settings();
    const run = f.manager.start(10);
    f.store.put("greenhouse_pull_run", run.id, {
      ...run,
      queryPlan: [run.queryPlan![0]],
    });
    await advanceUntil(f, () => f.manager.latest()!.status === "cooldown");
    const saved = f.manager.latest()!;
    assert.equal(saved.status, "cooldown");
    assert.equal(saved.page, 2);
    assert.equal(saved.pages.length, 1);
    assert.equal(saved.bridgeFailureCount, 1);
    assert.equal(saved.limitCount, 0);
    assert.equal(saved.pacingRate, 2000);
    assert.equal(saved.pacingIncreases, undefined);
    assert.equal(f.store.settings().version, settings.version);
    assert.match(saved.phase, /interval unchanged/);
    await f.restart();
    f.manager.action(saved.id, "resume");
    await f.manager.tick();
    assert.equal(f.manager.latest()!.bridgeFailureCount, 1);
    browser.removeTab();
    f.setTime(Date.parse(saved.retryAt!));
    browser.setTime(Date.parse(saved.retryAt!));
    await advanceUntil(f, () => f.manager.latest()!.pages.length === 3);
    assert.equal(f.manager.latest()!.status, "running");
    assert.equal(f.manager.latest()!.bridgeFailureCount, 0);
    assert.equal(f.manager.latest()!.pacingRate, 2000);
    assert.deepEqual(
      f.manager.latest()!.pages.map((page) => page.page),
      [1, 2, 3],
    );
    assert.equal(
      browser.calls.filter((call) => call.name === "tabs").length,
      2,
    );
    assert.ok(
      browser.calls.some(
        (call) =>
          call.name === "navigate" &&
          new URL(String(call.body.url)).searchParams.get("page") === "2",
      ),
    );
  } finally {
    await f.close();
  }
});

test("bridge request timeouts, unreadable responses and disconnected tabs retry without pacing increases", async () => {
  for (const mode of ["timeout", "body", "disconnected"]) {
    let fail = true;
    const browser = greenhouseBrowserFixture({
      bridgeFailure: (command) => {
        if (command !== "dom" || !fail) return;
        fail = false;
        if (mode === "timeout")
          throw new DOMException("Connection timed out", "TimeoutError");
        if (mode === "body") return new Response("Truncated bridge JSON");
        browser.removeTab();
        return new Response(JSON.stringify({ error: "Tab not connected" }));
      },
    });
    const f = fixture({
      page: browser.source.page.bind(browser.source),
      cancelSearch: browser.source.cancelSearch.bind(browser.source),
    });
    try {
      f.manager.start();
      await f.manager.tick();
      const saved = f.manager.latest()!;
      assert.equal(saved.status, "cooldown", mode);
      assert.equal(saved.page, 1);
      assert.equal(saved.pages.length, 0);
      assert.equal(saved.pacingRate, 2000);
      assert.equal(saved.limitCount, 0);
      f.setTime(Date.parse(saved.retryAt!));
      browser.setTime(Date.parse(saved.retryAt!));
      await advanceUntil(f, () => f.manager.latest()!.pages.length === 1);
      assert.equal(f.manager.latest()!.bridgeFailureCount, 0);
      assert.equal(f.store.settings().greenhousePacingRate, undefined);
      assert.equal(
        browser.calls.filter((call) => call.name === "tabs").length,
        mode === "disconnected" ? 2 : 1,
      );
    } finally {
      await f.close();
    }
  }
});

test("repeated bridge 5xx failures stop for attention after a persisted bounded retry budget", async () => {
  let attempts = 0;
  const browser = greenhouseBrowserFixture({
    bridgeFailure: (command) => {
      if (command !== "dom") return;
      attempts++;
      return new Response("Bridge unavailable", { status: 503 });
    },
  });
  const f = fixture({
    page: browser.source.page.bind(browser.source),
    cancelSearch: browser.source.cancelSearch.bind(browser.source),
  });
  try {
    const run = f.manager.start();
    for (let failure = 1; failure <= greenhouseBridgeFailureLimit; failure++) {
      await advanceUntil(
        f,
        () => f.manager.latest()!.bridgeFailureCount === failure,
      );
      const saved = f.manager.latest()!;
      assert.equal(saved.bridgeFailureCount, failure);
      assert.equal(saved.page, 1);
      assert.equal(saved.pacingRate, 2000);
      assert.equal(saved.limitCount, 0);
      if (failure === greenhouseBridgeFailureLimit) break;
      assert.equal(saved.status, "cooldown");
      if (failure === 2) {
        await f.restart();
        f.manager.action(run.id, "resume");
      }
      f.setTime(Date.parse(saved.retryAt!));
      browser.setTime(Date.parse(saved.retryAt!));
    }
    assert.equal(f.manager.latest()!.status, "failed");
    assert.equal(f.manager.latest()!.retryAt, undefined);
    assert.match(
      f.manager.latest()!.phase,
      /Check the configured browser bridge service and its health endpoint/,
    );
    assert.equal(
      f.manager.latest()!.failures.length,
      greenhouseBridgeFailureLimit,
    );
    assert.equal(f.store.settings().greenhousePacingRate, undefined);
    await f.manager.tick();
    assert.equal(attempts, greenhouseBridgeFailureLimit);
  } finally {
    await f.close();
  }
});

test("manual settings edits affect the next pull only; a finished unchanged run retains both intervals", async () => {
  const intervals: number[] = [];
  const f = fixture({
    page: async (query, page, employmentTypes, options) => {
      intervals.push(options!.pacingRate);
      return {
        query,
        page,
        employmentTypes,
        cards: [],
        more: false,
        status: 200,
        at: new Date(at).toISOString(),
        url: searchUrl(query, page, employmentTypes),
      };
    },
  });
  try {
    const run = f.manager.start();
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhousePacingRate: 1000,
    });
    for (let step = 0; step < 10; step++) await f.manager.tick();
    assert.ok(intervals.every((rate) => rate === 2000));
    assert.equal(f.manager.latest()!.status, "exhausted");
    assert.equal(f.manager.ledger(run.id).run.initialPacingRate, 2000);
    assert.equal(f.manager.ledger(run.id).run.finalPacingRate, 2000);
    assert.equal(f.manager.start().pacingRate, 1000);
  } finally {
    await f.close();
  }
});

test("pacing API validates bounds and versions, preserves settings, and survives restart/export without starting a pull", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "greenhouse-pacing-"));
  let workspace = await openFixtureWorkspace(root);
  try {
    const settings = workspace.store.settings();
    for (const pacingRate of [null, "2000", 999, 60001, 1500.5]) {
      const response = await workspace.post("/api/greenhouse/pacing", {
        expectedVersion: settings.version,
        pacingRate,
      });
      assert.equal(response.status, 400);
    }
    for (const pacingRate of [1000, 60000]) {
      const old = workspace.store.settings();
      const response = await workspace.post("/api/greenhouse/pacing", {
        expectedVersion: old.version,
        pacingRate,
      });
      assert.equal(response.status, 200);
      const saved = await response.json();
      assert.equal(saved.version, old.version + 1);
      assert.equal(saved.greenhousePacingRate, pacingRate);
      assert.deepEqual(saved.fitCriteria, settings.fitCriteria);
    }
    assert.equal(
      (
        await workspace.post("/api/greenhouse/pacing", {
          expectedVersion: settings.version,
          pacingRate: 2000,
        })
      ).status,
      409,
    );
    assert.equal(
      workspace.store.personalExport().records.settings[0].greenhousePacingRate,
      60000,
    );
    await workspace.close();
    workspace = await openFixtureWorkspace(root);
    const state = await (await workspace.get("/api/state")).json();
    assert.equal(state.settings.greenhousePacingRate, 60000);
    assert.equal(state.greenhousePull, null);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});
