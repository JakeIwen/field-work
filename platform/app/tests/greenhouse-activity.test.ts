import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fixture,
  at,
  card,
  advanceUntil,
} from "./fixtures/greenhouse-pull-fixture.js";
import { legacyOpening } from "./fixtures/legacy-records.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { normalizeFitCriteria } from "../shared/fit-criteria.js";
import {
  greenhouseActivityLane as lane,
  greenhouseActivityLevel as level,
  greenhouseActivityLimit,
  greenhouseActivityLaneLimit,
  type GreenhouseActivity,
} from "../shared/greenhouse-pull.js";
import {
  GreenhouseBridgeTransient,
  GreenhouseLimit,
  searchUrl,
} from "../server/greenhouse-source.js";
import { stageGreenhouseDecision } from "../server/greenhouse-pull.js";

const activity = (f: ReturnType<typeof fixture>) =>
  f.manager.ledger(f.manager.latest()!.id).run.activity;
const lines = (
  f: ReturnType<typeof fixture>,
  selected: GreenhouseActivity["lane"],
) => activity(f).filter((entry) => entry.lane === selected);
const runningReview = async (f: ReturnType<typeof fixture>) => {
  await advanceUntil(f, () =>
    f.store.list("task").some((task) => task.status === "running"),
  );
  return f.store.list("task").find((task) => task.status === "running")!;
};

// Exercise batch dispositions through collection, not the text formatter.
test("page activity reports post-triage new counts and one compact skip summary without individual exclusions", async () => {
  const f = fixture({
    page: async (query, page, employmentTypes) => ({
      query,
      page,
      employmentTypes,
      status: 200,
      more: false,
      at: new Date(at).toISOString(),
      url: searchUrl(query, page, employmentTypes),
      cards: [
        card("1"),
        { ...card("2"), title: "Proofreader" },
        { ...card("3"), company: "Blocked" },
        { ...card("4"), title: "Staff Software Engineer" },
        card("5"),
      ],
    }),
  });
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseExcludedCompanies: ["Blocked"],
      fitCriteria: normalizeFitCriteria({ titleExcludeTerms: ["Staff"] }),
    });
    f.store.put(
      "custom_opening",
      "saved",
      legacyOpening({ id: "saved", url: card("1").url, dismissed: true }),
    );
    f.manager.start();
    await f.manager.tick();
    assert.deepEqual(
      lines(f, lane.search).map((entry) => entry.text),
      [
        "software engineer · Full time, page 1: 5 results, 1 new for review",
        "2 skipped by title, 1 by company filter, 1 already saved, 0 reviewed in earlier pulls",
        "software engineer · Full time: searched to the end",
      ],
    );
    assert.deepEqual(lines(f, lane.review), []);
    assert.equal(f.manager.state()!.excluded, 3);
    assert.equal(f.manager.state()!.existing, 1);
    assert.equal(f.store.list("task").length, 0);
  } finally {
    await f.close();
  }
});

test("cooldown and pacing edges are persisted once, survive restart, and resume the saved page", async () => {
  let first = true;
  const f = fixture({
    page: async (query, page, employmentTypes) => {
      if (first) {
        first = false;
        throw new GreenhouseLimit(
          "HTTP 429",
          new Date(at + 300000).toISOString(),
        );
      }
      return {
        query,
        page,
        employmentTypes,
        status: 200,
        more: false,
        cards: [],
        at: new Date(at).toISOString(),
        url: searchUrl(query, page, employmentTypes),
      };
    },
  });
  try {
    const run = f.manager.start();
    await f.manager.tick();
    assert.deepEqual(
      lines(f, lane.search).map((entry) => entry.text),
      [
        "Cooldown started until 2026-09-28T20:05:00.000Z: HTTP 429",
        "Page interval 2 s → 3 s after HTTP 429",
      ],
    );
    assert.ok(
      lines(f, lane.search).every((entry) => entry.level === level.warn),
    );
    await f.manager.tick();
    assert.equal(activity(f).length, 2);
    await f.restart();
    f.manager.action(run.id, "resume");
    f.setTime(at + 300001);
    await f.manager.tick();
    assert.ok(
      lines(f, lane.search).some(
        (entry) => entry.text === "Cooldown over; resuming saved progress",
      ),
    );
    assert.equal(f.manager.ledger(run.id).run.pages[0].page, 1);
    assert.deepEqual(
      f.store.personalExport().records.greenhouse_pull_run[0].activity,
      activity(f),
    );
  } finally {
    await f.close();
  }
});

test("bridge retry and terminal failure activity retain causes without changing search pacing", async () => {
  const f = fixture({
    page: async () => {
      throw new GreenhouseBridgeTransient("Chrome tab disconnected");
    },
  });
  try {
    f.manager.start();
    for (let i = 0; i < 5; i++) {
      await f.manager.tick();
      const run = f.manager.latest()!;
      if (run.retryAt) f.setTime(Date.parse(run.retryAt));
    }
    const search = lines(f, lane.search);
    assert.equal(
      search.filter((entry) => entry.text.startsWith("Chrome bridge retry"))
        .length,
      4,
    );
    assert.match(
      search.at(-1)!.text,
      /Run failed: Chrome tab disconnected; check the configured browser bridge service and its health endpoint/,
    );
    assert.equal(search.at(-1)!.level, level.error);
    assert.equal(f.manager.latest()!.pacingRate, 2000);
  } finally {
    await f.close();
  }
});

test("userscript fallback is logged once per run rather than once per page", async () => {
  const note = "MyGreenhouse userscript not detected; loading pages by URL";
  const f = fixture({
    page: async (query, page, employmentTypes, options) => {
      options?.onTransport?.("navigation", note);
      return {
        query,
        page,
        employmentTypes,
        status: 200,
        more: false,
        cards: [],
        at: new Date(at).toISOString(),
        url: searchUrl(query, page, employmentTypes),
      };
    },
  });
  try {
    f.manager.start();
    await f.manager.tick();
    await f.manager.tick();
    const fallback = lines(f, lane.search).filter(
      (entry) => entry.text === note,
    );
    assert.equal(fallback.length, 1);
    assert.equal(fallback[0].level, level.warn);
  } finally {
    await f.close();
  }
});

test("review starts, additions and target activity commit with the saved outcome and retain conversation links", async () => {
  const f = fixture();
  try {
    f.manager.start(1);
    const task = await runningReview(f);
    assert.equal(
      lines(f, lane.review)[0].text,
      "Reviewing Example · Software Engineer 1",
    );
    assert.equal(lines(f, lane.review)[0].taskId, task.id);
    f.finish();
    await f.manager.tick();
    assert.equal(
      lines(f, lane.review).at(-1)!.text,
      "Added Example · Software Engineer 1",
    );
    assert.equal(lines(f, lane.review).at(-1)!.taskId, task.id);
    assert.equal(
      lines(f, lane.search).at(-1)!.text,
      "Target reached; finishing 2 reviews",
    );
    assert.equal(f.manager.state()!.status, "finishing");
    const before = activity(f);
    await f.manager.tick();
    assert.deepEqual(activity(f), before);
  } finally {
    await f.close();
  }
});

test("review exclusions and deferrals summarize their saved reasons without newlines or verbose evidence", async () => {
  for (const decision of ["excluded", "deferred"] as const) {
    const f = fixture();
    try {
      f.manager.start(1);
      const task = await runningReview(f);
      const candidate = f.store
        .list("greenhouse_pull_candidate")
        .find((c) => c.taskId === task.id)!;
      stageGreenhouseDecision(
        f.store,
        task,
        {
          decision,
          reason: `Duties remain unclear.\n${"More evidence needed. ".repeat(20)}`,
          softwareAssessment:
            "Software responsibilities require clarification.",
          remoteAssessment: "US remote in the official source.",
          fitAssessment: "Confirm the actual requirements.",
          sources: [candidate.posting!.apiUrl],
        },
        true,
      );
      const completed = f.store.get("task", task.id);
      assert.ok(completed);
      f.store.put("task", task.id, {
        ...completed,
        status: "completed",
      });
      await f.manager.tick();
      const entry = lines(f, lane.review).at(-1)!;
      const prefix = `${decision === "excluded" ? "Excluded" : "Deferred"} Example · Software Engineer 1: `;
      assert.ok(entry.text.startsWith(prefix));
      assert.equal(entry.text.slice(prefix.length).length, 100);
      assert.ok(entry.text.endsWith("…"));
      assert.ok(!entry.text.includes("\n"));
      assert.equal(entry.taskId, task.id);
      assert.equal(
        entry.level,
        decision === "deferred" ? level.warn : level.info,
      );
    } finally {
      await f.close();
    }
  }
});

test("a newly discovered duplicate during review logs Already saved rather than Added", async () => {
  const f = fixture();
  try {
    f.manager.start(1);
    const task = await runningReview(f);
    f.store.put(
      "custom_opening",
      "saved",
      legacyOpening({ id: "saved", url: card("1").url }),
    );
    f.finish();
    await f.manager.tick();
    const entry = lines(f, lane.review).at(-1)!;
    assert.equal(entry.text, "Already saved Example · Software Engineer 1");
    assert.equal(entry.taskId, task.id);
    assert.equal(f.manager.state()!.added, 0);
  } finally {
    await f.close();
  }
});

test("needs-input and interrupted review lines are emitted on status edges, not every scheduler tick", async () => {
  const f = fixture();
  try {
    f.manager.start(1);
    const task = await runningReview(f);
    f.store.put("task", task.id, { ...task, status: "waiting for input" });
    for (let i = 0; i < 3; i++) await f.manager.tick();
    assert.equal(
      lines(f, lane.review).filter((entry) =>
        entry.text.startsWith("Needs input"),
      ).length,
      1,
    );
    f.store.put("task", task.id, {
      ...task,
      status: "interrupted",
      error: "Review was interrupted",
    });
    for (let i = 0; i < 3; i++) await f.manager.tick();
    const failures = lines(f, lane.review).filter((entry) =>
      entry.text.startsWith("Review interrupted"),
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0].taskId, task.id);
    assert.equal(failures[0].level, level.error);
  } finally {
    await f.close();
  }
});

test("pause/resume and both stop policies keep review disposition visible", async () => {
  for (const interrupt of [false, true]) {
    const f = fixture();
    try {
      const run = f.manager.start(1);
      await runningReview(f);
      f.manager.action(run.id, "pause");
      f.manager.action(run.id, "resume");
      f.manager.action(run.id, "stop", interrupt);
      const search = lines(f, lane.search).map((entry) => entry.text);
      assert.ok(search.includes("Paused"));
      assert.ok(search.includes("Resumed saved progress"));
      assert.match(search.at(-1)!, /Stopped searching/);
      if (interrupt)
        assert.equal(lines(f, lane.review).at(-1)!.text, "Stopped 3 reviews");
      else
        assert.equal(search.at(-1), "Stopped searching; finishing 3 reviews");
      if (!interrupt) {
        f.finish();
        await f.manager.tick();
        assert.match(lines(f, lane.review).at(-1)!.text, /^Added /);
      }
    } finally {
      await f.close();
    }
  }
});

test("collection caps each run at 200 entries, dropping oldest activity and retaining the ledger in exports", async () => {
  const f = fixture({
    page: async (query, page, employmentTypes) => ({
      query,
      page,
      employmentTypes,
      status: 200,
      more: page < 15,
      cards: [{ ...card(`${query}-${page}`), title: "Proofreader" }],
      at: new Date(at).toISOString(),
      url: searchUrl(query, page, employmentTypes),
    }),
  });
  try {
    f.manager.start();
    await advanceUntil(f, () => f.manager.state()!.status === "exhausted", 150);
    assert.equal(activity(f).length, greenhouseActivityLimit);
    assert.ok(
      !activity(f).some(
        (entry) =>
          entry.text ===
          "software engineer, page 1: 1 results, 0 new for review",
      ),
    );
    assert.equal(activity(f).at(-1)!.text, "Selected searches reached the end");
    assert.equal(
      f.store.personalExport().records.greenhouse_pull_run[0].activity!.length,
      greenhouseActivityLimit,
    );
    assert.equal(lines(f, lane.review).length, 0);
    assert.equal(
      f.manager.state()!.activity!.length,
      greenhouseActivityLaneLimit,
    );
  } finally {
    await f.close();
  }
});

test("HTTP state keeps only 30 entries per lane while ledger retains all activity and legacy reads empty", async () => {
  const f = fixture();
  const root = mkdtempSync(
    path.join(os.tmpdir(), "greenhouse-activity-state-"),
  );
  const workspace = await openFixtureWorkspace(root);
  try {
    const run = f.manager.start();
    const saved = Object.values(lane).flatMap((selected) =>
      Array.from({ length: 40 }, (_, index) => ({
        at: new Date(at + index * 1000).toISOString(),
        lane: selected,
        level: level.info,
        text: `Event ${index}`,
      })),
    );
    workspace.store.put("greenhouse_pull_run", run.id, {
      ...run,
      status: "stopped",
      activity: saved,
    });
    const state = await (await workspace.get("/api/state")).json();
    for (const selected of Object.values(lane)) {
      const entries = state.greenhousePull.activity.filter(
        (entry: GreenhouseActivity) => entry.lane === selected,
      );
      assert.equal(entries.length, greenhouseActivityLaneLimit);
      assert.equal(entries[0].text, "Event 10");
      assert.equal(entries.at(-1).text, "Event 39");
    }
    const endpoint = `/api/greenhouse/pulls/${run.id}/ledger`;
    const ledger = await (await workspace.get(endpoint)).json();
    assert.deepEqual(ledger.run.activity, saved);
    const legacy = { ...run, status: "stopped" as const };
    delete legacy.activity;
    workspace.store.put("greenhouse_pull_run", run.id, legacy);
    assert.deepEqual(
      (await (await workspace.get("/api/state")).json()).greenhousePull
        .activity,
      [],
    );
    assert.deepEqual(
      (await (await workspace.get(endpoint)).json()).run.activity,
      [],
    );
    assert.equal(
      workspace.store.get("greenhouse_pull_run", run.id)?.activity,
      undefined,
    );
  } finally {
    await workspace.close();
    await f.close();
    rmSync(root, { recursive: true, force: true });
  }
});
