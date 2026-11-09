import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import {
  metricRun,
  metricCandidate,
  saveMetricReview,
} from "./fixtures/pull-metrics.js";
import { card, posting } from "./fixtures/greenhouse-pull-fixture.js";
import { Store } from "../server/storage.js";
import { pullMetrics } from "../server/opening-pull/pull-metrics.js";
import { parsePullMetricsQuery } from "../server/opening-pull/metrics-query.js";
import {
  pullMetricsPath,
  pullMetricsResponseBudget,
  type PullMetricsResponse,
} from "../shared/greenhouse-pull-metrics.js";
import { legacyTask } from "./fixtures/legacy-records.js";

function seedMetrics(store: Store) {
  for (const id of ["first", "second"])
    store.put(
      "greenhouse_pull_run",
      id,
      metricRun(id, {
        createdAt:
          id === "first" ? "2026-09-27T20:00:00Z" : "2026-09-28T20:00:00Z",
      }),
    );
  const candidates = [
    metricCandidate("first", "1"),
    metricCandidate("second", "1"),
    metricCandidate("first", "2", {
      state: "deferred",
      reason:
        "Official API has no usable original publication date. Freshness cannot be established.",
    }),
    metricCandidate("first", "3", {
      state: "existing",
      reason: "Already saved in Fieldwork.",
    }),
    metricCandidate("first", "4", { state: "added" }),
    metricCandidate("first", "5", {
      state: "discovered",
      waitingFor: "first:example:6",
    }),
    metricCandidate("first", "6", { state: "reviewing" }),
    metricCandidate("first", "7", {
      reason: "Title triage: “SRE” matches your excluded title term “SRE”.",
    }),
    metricCandidate("first", "8", {
      reason:
        "Title triage: “Data Engineer” matches your excluded title term “Data Engineer”.",
    }),
  ];
  for (const candidate of candidates)
    store.put("greenhouse_pull_candidate", candidate.id, {
      ...candidate,
      posting: {
        ...posting(candidate.card),
        text: "DO_NOT_RETURN_POSTING_BODY".repeat(1000),
      },
    });
  const reviewed = saveMetricReview(store, "first", "10");
  saveMetricReview(store, "first", "11", "deferred");
  store.put("greenhouse_pull_candidate", "second:example:10", {
    ...reviewed,
    id: "second:example:10",
    runId: "second",
    reviewed: undefined,
    remembered: {
      memoryId: "example:10",
      decidedAt: "2026-09-27T21:00:00Z",
      outcome: "excluded",
    },
    reason: `Reviewed Sep 27 (Excluded): ${reviewed.reason}`,
  });
}

test("metrics HTTP endpoint projects states, deduplicates across pulls and keeps duplicates out of discard totals", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-pull-metrics-"));
  const workspace = await openFixtureWorkspace(root);
  const read = async (query = "") => {
    const response = await workspace.get(pullMetricsPath + query);
    assert.equal(response.status, 200);
    return (await response.json()) as PullMetricsResponse;
  };
  try {
    seedMetrics(workspace.store);
    const scan = await read();
    assert.deepEqual(scan.totals, {
      postings: 4,
      occurrences: 5,
      discards: 4,
      duplicates: 1,
      remembered: 0,
    });
    const searchDate = scan.groups.items.find(
      (group) => group.key === "searchDate",
    );
    assert.equal(searchDate?.count, 1);
    assert.equal(searchDate?.occurrences, 2);
    assert.equal(searchDate?.share, 0.25);
    assert.ok(scan.metrics.some((item) => item.detail === "SRE"));
    assert.ok(scan.metrics.some((item) => item.detail === "Data Engineer"));
    assert.equal(scan.postings, undefined);
    const duplicates = await read("?includeDuplicates=true");
    assert.equal(duplicates.totals.postings, 5);
    assert.equal(duplicates.totals.discards, 4);
    assert.equal(
      duplicates.groups.items.find((group) => group.key === "duplicate")?.share,
      null,
    );
    const group = await read("?group=searchDate");
    assert.equal(group.postings?.items.length, 1);
    assert.equal(group.postings.items[0].occurrences, 2);
    assert.equal(group.postings.items[0].runId, "second");
    assert.equal(
      JSON.stringify(group).includes("DO_NOT_RETURN_POSTING_BODY"),
      false,
    );
    const companies = await read("?groupBy=company");
    assert.equal(companies.groups.items[0].count, 4);
    const pulls = await read("?groupBy=pull&sort=name");
    assert.deepEqual(
      pulls.groups.items.map((group) => group.key),
      ["first", "second"],
    );
    const filtered = await read("?metric=titleTerm%3Asre&search=Example");
    assert.equal(filtered.totals.postings, 1);
    assert.equal((await read("?search=not-present")).totals.postings, 0);
    for (const query of [
      "?section=other",
      "?groupBy=invalid",
      "?offset=-1",
      "?offset=1.5",
      "?includeDuplicates=yes",
      "?sort=count&sort=name",
    ])
      assert.equal((await workspace.get(pullMetricsPath + query)).status, 400);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("metrics review evidence retains full decisions, captured instructions, prompts and remembered provenance", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-review-metrics-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    seedMetrics(workspace.store);
    const response = await workspace.get(
      pullMetricsPath + "?section=agent&posting=example%3A10",
    );
    assert.equal(response.status, 200);
    const metrics = (await response.json()) as PullMetricsResponse;
    assert.equal(metrics.totals.discards, 2);
    assert.equal(metrics.totals.occurrences, 3);
    assert.equal(metrics.totals.remembered, 1);
    assert.equal(
      metrics.groups.items.find((group) => group.key === "location")?.count,
      2,
    );
    assert.equal(metrics.evidence?.items.length, 2);
    const item = metrics.evidence.items.find((item) => item.runId === "second");
    assert.ok(item);
    assert.equal(
      item.reason,
      "Remote within Canada only; US-based applicants are not eligible.",
    );
    assert.match(item.softwareAssessment!, /production software/);
    assert.match(item.remoteAssessment!, /restricted to Canada/);
    assert.match(item.fitAssessment!, /supplied experience/);
    assert.match(item.instructions!, /Prefer part-time/);
    assert.equal(item.prompt, "Captured initial review prompt for 10.");
    assert.equal(item.promptSource, "captured");
    assert.equal(item.taskId, "review-10");
    assert.equal(item.rememberedAt, "2026-09-27T21:00:00Z");
    assert.match(metrics.reviewInstructions, /Make exactly one final decision/);
    workspace.store.db
      .prepare("DELETE FROM records WHERE kind='task' AND id=?")
      .run("review-10");
    const missing = pullMetrics(
      workspace.store,
      parsePullMetricsQuery({ section: "agent", posting: "example:10" }),
    );
    assert.ok(missing.evidence?.items.some((item) => item.rememberedAt));
    assert.equal(
      missing.evidence?.items.find((item) => item.rememberedAt)
        ?.softwareAssessment,
      undefined,
    );
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function measureMetricsProjection(store: Store) {
  const list = store.list,
    get = store.get;
  store.list = () => {
    throw new Error("Whole histories must not be loaded");
  };
  store.get = new Proxy(get, {
    apply(target, receiver, args) {
      // The current policy is small; candidate/task histories must stay projected.
      if (args[0] === "settings") return Reflect.apply(target, receiver, args);
      throw new Error("Whole records must not be loaded");
    },
  });
  try {
    const started = performance.now();
    const summary = pullMetrics(store, parsePullMetricsQuery({}));
    const elapsed = performance.now() - started;
    const rowsStart = performance.now();
    const rows = pullMetrics(
      store,
      parsePullMetricsQuery({ group: "searchDate" }),
    );
    return {
      summary,
      rows,
      elapsed,
      rowElapsed: performance.now() - rowsStart,
    };
  } finally {
    store.list = list;
    store.get = get;
  }
}

test("3,000-candidate projection stays bounded and never loads full candidate/task histories", (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "fieldwork-metric-volume-"));
  const store = new Store(root, path.join(root, "data"));
  const fullPosting = {
    ...posting(card("1")),
    raw: { content: "DO_NOT_RETURN_POSTING_BODY".repeat(1300) },
  };
  try {
    store.transaction(() => {
      store.put("greenhouse_pull_run", "volume", metricRun("volume"));
      store.put(
        "task",
        "large-task",
        legacyTask({
          id: "large-task",
          events: [
            {
              method: "fixture",
              message: "DO_NOT_RETURN_TASK_CONTEXT".repeat(40_000),
            },
          ],
        }),
      );
      for (let index = 0; index < 3000; index++) {
        const candidate = metricCandidate("volume", String(index), {
          posting: fullPosting,
          taskId: "large-task",
        });
        store.put("greenhouse_pull_candidate", candidate.id, candidate);
      }
    });
    const { summary, rows, elapsed, rowElapsed } =
      measureMetricsProjection(store);
    const bytes = Buffer.byteLength(JSON.stringify(summary)),
      rowBytes = Buffer.byteLength(JSON.stringify(rows));
    context.diagnostic(
      JSON.stringify({
        candidates: 3000,
        embeddedPostingBytes: Buffer.byteLength(JSON.stringify(fullPosting)),
        summaryBytes: bytes,
        summaryMs: Math.round(elapsed),
        rowPageBytes: rowBytes,
        rowPageMs: Math.round(rowElapsed),
      }),
    );
    assert.equal(summary.totals.discards, 3000);
    assert.equal(rows.postings?.items.length, 25);
    assert.equal(rows.postings?.nextOffset, 25);
    assert.ok(
      bytes < pullMetricsResponseBudget && rowBytes < pullMetricsResponseBudget,
    );
    assert.equal(JSON.stringify(rows).includes("DO_NOT_RETURN"), false);
    const next = pullMetrics(
      store,
      parsePullMetricsQuery({ group: "searchDate", offset: "25" }),
    );
    assert.equal(
      next.postings?.items.some((item) =>
        rows.postings?.items.some((first) => first.key === item.key),
      ),
      false,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
