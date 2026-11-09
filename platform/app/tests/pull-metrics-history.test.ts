import assert from "node:assert/strict";
import test from "node:test";
import {
  fixture,
  at,
  posting,
  card,
  advanceUntil,
} from "./fixtures/greenhouse-pull-fixture.js";
import { metricRun, saveMetricReview } from "./fixtures/pull-metrics.js";
import { legacyOpening } from "./fixtures/legacy-records.js";
import { pullMetrics } from "../server/opening-pull/pull-metrics.js";
import { parsePullMetricsQuery } from "../server/opening-pull/metrics-query.js";
import { classifyPullScreen } from "../server/opening-pull/metric-classifiers.js";
import { rememberedReviewLabel } from "../server/opening-pull/review-memory.js";
import { pullMetricsResponseBudget } from "../shared/greenhouse-pull-metrics.js";

test("remembered evidence can recover its original task from matching memory, never a replacement decision", async () => {
  const f = fixture();
  try {
    const run = metricRun("first");
    f.store.put("greenhouse_pull_run", run.id, run);
    const original = saveMetricReview(f.store, run.id, "10");
    const memory = {
      id: "example:10",
      board: "example",
      aliases: ["10"],
      outcome: "excluded" as const,
      decidedAt: new Date(at).toISOString(),
      runId: run.id,
      candidateId: original.id,
      taskId: original.taskId!,
      reason: original.reason!,
      fingerprint: "fixture",
      postingContentHash: "fixture",
    };
    f.store.put("greenhouse_review_memory", memory.id, memory);
    const label = rememberedReviewLabel(memory);
    f.store.put("greenhouse_pull_candidate", original.id, {
      ...original,
      reviewed: undefined,
      taskId: undefined,
      reason: `${label[0].toUpperCase()}${label.slice(1)}: ${memory.reason}`,
      remembered: {
        memoryId: memory.id,
        decidedAt: memory.decidedAt,
        outcome: memory.outcome,
      },
    });
    const query = parsePullMetricsQuery({
      section: "agent",
      posting: "example:10",
    });
    const first = pullMetrics(f.store, query).evidence?.items[0];
    assert.equal(first?.taskId, original.taskId);
    assert.equal(first?.reason, original.reason);
    assert.match(first?.remoteAssessment ?? "", /restricted to Canada/);
    f.store.put("greenhouse_review_memory", memory.id, {
      ...memory,
      decidedAt: "2026-10-01T20:00:00Z",
      taskId: "another-review",
      reason: "A later review reached a different conclusion.",
    });
    const later = pullMetrics(f.store, query).evidence?.items[0];
    assert.equal(later?.taskId, undefined);
    assert.equal(later?.softwareAssessment, undefined);
    assert.match(later?.reason ?? "", /US-based applicants are not eligible/);
    assert.equal(later?.promptSource, "current-template");
  } finally {
    await f.close();
  }
});

test("later review edits and task deletion preserve the historical agent outcome instead of relabeling it as a screen", async () => {
  const f = fixture();
  try {
    const run = metricRun("first");
    f.store.put("greenhouse_pull_run", run.id, run);
    const candidate = saveMetricReview(f.store, run.id, "20");
    const task = f.store.get("task", candidate.taskId!);
    assert.ok(task?.preset === "opening-research");
    f.store.put("task", task.id, {
      ...task,
      greenhouseDecision: {
        decision: "excluded",
        reason: "A different later reason referencing compensation.",
      },
    });
    const query = parsePullMetricsQuery({
      section: "agent",
      posting: "example:20",
    });
    const edited = pullMetrics(f.store, query);
    assert.equal(edited.evidence?.items[0].reason, candidate.reason);
    assert.equal(edited.evidence?.items[0].softwareAssessment, undefined);
    assert.deepEqual(edited.evidence?.items[0].metrics, [
      { metric: "location" },
    ]);
    f.store.db
      .prepare("DELETE FROM records WHERE kind='task' AND id=?")
      .run(task.id);
    const deleted = pullMetrics(f.store, query);
    assert.equal(deleted.totals.discards, 1);
    assert.equal(deleted.evidence?.items[0].reason, candidate.reason);
  } finally {
    await f.close();
  }
});

test("retrieved requisition aliases produce duplicate metrics, not fit discards", async () => {
  const f = fixture({
    posting: async (c) =>
      c.id === "2" ? { ...posting(c), aliases: ["1", "2"] } : posting(c),
  });
  try {
    f.store.put(
      "custom_opening",
      "saved",
      legacyOpening({
        id: "saved",
        url: card("1").url,
        title: card("1").title,
        company: "Example",
      }),
    );
    const run = f.manager.start();
    await advanceUntil(f, () => f.manager.state()?.existing === 2);
    const duplicate = f.manager
      .ledger(run.id)
      .candidates.find((candidate) => candidate.card.id === "2");
    assert.ok(duplicate?.reason);
    assert.deepEqual(classifyPullScreen(duplicate.reason), [
      { metric: "duplicate" },
    ]);
    const summary = pullMetrics(
      f.store,
      parsePullMetricsQuery({ includeDuplicates: "true" }),
    );
    assert.equal(summary.totals.duplicates, 2);
    assert.equal(summary.totals.discards, 0);
  } finally {
    await f.close();
  }
});

test("pull group dates use configured-timezone calendar days", async () => {
  const f = fixture();
  try {
    f.store.put(
      "greenhouse_pull_run",
      "night",
      metricRun("night", { createdAt: "2026-10-26T02:00:00Z" }),
    );
    saveMetricReview(f.store, "night", "20");
    const result = pullMetrics(
      f.store,
      parsePullMetricsQuery({ section: "agent", groupBy: "pull" }),
    );
    assert.equal(result.groups.items[0].label, "2026-10-25 · night");
  } finally {
    await f.close();
  }
});

test("large full-text decisions paginate by byte budget without truncating their evidence", async () => {
  const f = fixture();
  try {
    const candidate = saveMetricReview(f.store, "first", "20");
    const task = f.store.get("task", candidate.taskId!);
    assert.ok(task?.preset === "opening-research");
    const fullText = "根".repeat(8000);
    f.store.put("task", task.id, {
      ...task,
      greenhouseDecision: {
        decision: "excluded",
        reason: fullText,
        softwareAssessment: fullText,
        remoteAssessment: fullText,
        fitAssessment: fullText,
      },
    });
    for (const id of ["first", "second", "third", "fourth", "fifth"]) {
      f.store.put("greenhouse_pull_run", id, metricRun(id));
      f.store.put("greenhouse_pull_candidate", `${id}:example:20`, {
        ...candidate,
        id: `${id}:example:20`,
        runId: id,
        reason: fullText,
      });
    }
    const seen = new Set<string>();
    let offset: number | null = 0;
    while (offset !== null) {
      const result = pullMetrics(
        f.store,
        parsePullMetricsQuery({
          section: "agent",
          posting: "example:20",
          offset: String(offset),
        }),
      );
      assert.ok(
        Buffer.byteLength(JSON.stringify(result)) < pullMetricsResponseBudget,
      );
      assert.equal(result.evidence?.total, 5);
      assert.equal(result.evidence.items.length, 1);
      const item = result.evidence.items[0];
      assert.equal(seen.has(item.candidateId), false);
      seen.add(item.candidateId);
      assert.equal(item.reason, fullText);
      assert.equal(item.fitAssessment, fullText);
      offset = result.evidence.nextOffset;
    }
    assert.equal(seen.size, 5);
  } finally {
    await f.close();
  }
});
