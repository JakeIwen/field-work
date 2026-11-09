import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { memoryFixture } from "./fixtures/greenhouse-memory.js";
import { at, card, posting } from "./fixtures/greenhouse-pull-fixture.js";
import { applicationEvidencePaths } from "../server/application-evidence.js";
import {
  deferredReviewMemoryMs,
  reviewMemoryKind,
  rereviewCandidate,
} from "../server/opening-pull/review-memory.js";
import { backfillReviewMemory } from "../server/opening-pull/review-memory-backfill.js";
import { reviewInputsFile } from "../server/opening-pull/review-inputs.js";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

async function seed(
  f: ReturnType<typeof memoryFixture>,
  outcome: "excluded" | "deferred" = "excluded",
) {
  f.manager.start(10, "first");
  const task = await f.running();
  const candidate = await f.finish(outcome);
  await f.exhaust();
  assert.equal(f.store.list(reviewMemoryKind).length, 1);
  return { task, candidate };
}

test("the initial prompt does not block memory, but a later user message does", async () => {
  const f = memoryFixture();
  try {
    f.manager.start(10, "first");
    const task = await f.running();
    const started = f.store.get("task", task.id);
    assert.equal(
      started?.messages?.filter((message) => message.role === "user").length,
      1,
    );
    f.store.put("task", task.id, {
      ...started!,
      messages: [
        ...(started!.messages ?? []),
        {
          id: `${task.id}:steer`,
          role: "user",
          text: "Treat contractor roles as eligible.",
          at: new Date(at).toISOString(),
          delivery: "queued",
        },
      ],
    });
    await f.finish("excluded");
    await f.exhaust();
    assert.equal(f.store.list(reviewMemoryKind).length, 0);
  } finally {
    await f.close();
  }
});

test("completed exclusion is reused across pulls, retaining the task link, counts, page activity and private export", async () => {
  const f = memoryFixture();
  try {
    const { task } = await seed(f);
    const run = f.manager.start(10, "second");
    await f.exhaust();
    const candidate = f.manager.ledger(run.id).candidates[0];
    assert.equal(candidate.state, "excluded");
    assert.equal(candidate.taskId, task.id);
    assert.ok(candidate.remembered);
    assert.match(candidate.reason ?? "", /^Reviewed Sep 28 \(Excluded\):/);
    assert.equal(f.store.list("task").length, 1);
    assert.equal(
      f.controls.fetches.length,
      2,
      "official posting and deterministic checks still run",
    );
    assert.equal(f.manager.state()?.remembered, 1);
    assert.equal(f.manager.state()?.excluded, 1);
    assert.equal(f.manager.state()?.reviewed, 0);
    const activity = f.manager.ledger(run.id).run.activity;
    assert.equal(activity.filter((item) => item.remembered).length, 1);
    assert.match(
      activity.find((item) => item.remembered)?.text ?? "",
      /^Skipped Example · Software Engineer 1: reviewed Sep 28 \(Excluded\)$/,
    );
    assert.equal(
      activity.find((item) => item.remembered)?.candidateId,
      candidate.id,
    );
    assert.ok(
      activity.some((item) =>
        item.text.includes("1 reviewed in earlier pulls"),
      ),
    );
    assert.equal(
      f.store.personalExport().records.greenhouse_review_memory.length,
      1,
    );
    const memory = f.store.list(reviewMemoryKind)[0];
    await f.restart();
    assert.deepEqual(f.store.list(reviewMemoryKind), [memory]);
  } finally {
    await f.close();
  }
});

for (const change of [
  "guidance",
  "posting",
  "evidence",
  "template",
  "fit criteria",
] as const)
  test(`${change} change invalidates review memory`, async () => {
    const f = memoryFixture();
    try {
      if (change === "template")
        f.controls.templateSuffix = "\nEarlier review policy.";
      await seed(f);
      f.controls.templateSuffix = "";
      if (change === "guidance")
        f.store.put("settings", "main", {
          ...f.store.settings(),
          greenhouseGuidance: {
            instructions:
              "Include European roles if US contracting is explicitly supported.",
            searchTerms: [],
          },
        });
      if (change === "posting")
        f.controls.posting = (item) => ({
          ...posting(item),
          text: posting(item).text + " US contracting is now possible.",
        });
      if (change === "evidence")
        writeFileSync(
          path.join(f.root, applicationEvidencePaths[1]),
          "Changed evidence with new supported experience.",
        );
      if (change === "fit criteria")
        f.store.put("settings", "main", {
          ...f.store.settings(),
          fitCriteria: {
            ...f.store.settings().fitCriteria,
            technologyExcludeTerms: ["COBOL"],
          },
        });
      f.manager.start(10, "second");
      await f.running();
      assert.equal(f.store.list("task").length, 2);
      assert.equal(f.manager.state()?.remembered, 0);
    } finally {
      await f.close();
    }
  });

for (const elapsed of [deferredReviewMemoryMs - 1, deferredReviewMemoryMs])
  test(`deferred memory at ${elapsed} milliseconds`, async () => {
    const f = memoryFixture();
    try {
      await seed(f, "deferred");
      f.controls.setTime(at + elapsed);
      f.manager.start(10, "second");
      if (elapsed < deferredReviewMemoryMs) {
        await f.exhaust();
        assert.equal(f.manager.state()?.remembered, 1);
        assert.equal(f.manager.state()?.deferred, 1);
      } else {
        await f.running();
        assert.equal(f.store.list("task").length, 2);
      }
    } finally {
      await f.close();
    }
  });

for (const changed of [false, true])
  test(`requisition alias requires matching content (${changed ? "changed" : "same"})`, async () => {
    const f = memoryFixture();
    try {
      await seed(f);
      f.controls.cards = [{ ...card("2"), title: card("1").title }];
      f.controls.posting = (item) => ({
        ...posting(item),
        aliases: ["1", "2"],
        raw: { ...posting(item).raw, internal_job_id: "req-1" },
        text:
          posting(item).text + (changed ? " Different geographic scope." : ""),
      });
      f.manager.start(10, "second");
      if (changed) {
        await f.running();
        assert.equal(f.store.list("task").length, 2);
      } else {
        await f.exhaust();
        assert.equal(f.manager.state()?.remembered, 1);
      }
    } finally {
      await f.close();
    }
  });

test("old search dates are excluded before fetch; undated and exactly eight-day cards reach authoritative API", async () => {
  const f = memoryFixture();
  try {
    f.controls.cards = [
      {
        ...card("1"),
        firstPublished: new Date(at - 8 * 86400000 - 1).toISOString(),
      },
      { ...card("2"), firstPublished: null },
      {
        ...card("3"),
        firstPublished: new Date(at - 8 * 86400000).toISOString(),
      },
    ];
    f.controls.posting = (item) => ({
      ...posting(item),
      raw: { ...posting(item).raw, first_published: card("1").firstPublished },
    });
    f.manager.start();
    await f.tickUntil(() => f.controls.fetches.length === 2);
    assert.deepEqual(f.controls.fetches.sort(), ["2", "3"]);
    const rows = f.store.list("greenhouse_pull_candidate");
    assert.equal(
      rows.find((item) => item.card.id === "1")?.reason,
      "Older than 8 days by search date",
    );
    assert.equal(f.store.list(reviewMemoryKind).length, 0);
    assert.ok(
      f.manager
        .state()
        ?.activity?.some((item) =>
          item.text.includes("1 older than 8 days by search date"),
        ),
    );
  } finally {
    await f.close();
  }
});

test("backfill is guarded and only imports complete, matching captured decisions", async () => {
  const f = memoryFixture();
  try {
    const { candidate } = await seed(f);
    f.store.remove(reviewMemoryKind, "example:1");
    const task = f.store.get("task", candidate.taskId!);
    assert.ok(task && task.preset === "opening-research");
    for (const variant of [
      "legacy",
      "missing guidance",
      "changed posting",
      "missing policy",
      "retired source",
    ] as const) {
      const id = `old-${variant}`;
      const run = f.manager.latest();
      assert.ok(run);
      const runId = `${run.id}-${id}`;
      const clone = { ...candidate, id, runId, taskId: `${task.id}-${id}` };
      f.store.put("greenhouse_pull_run", runId, {
        ...run,
        id: runId,
        ...(variant === "missing guidance" ? { guidance: undefined } : {}),
        ...(variant === "retired source"
          ? { providers: ["ashby" as const] }
          : {}),
      });
      f.store.put("greenhouse_pull_candidate", id, {
        ...clone,
        ...(variant === "changed posting"
          ? { posting: { ...candidate.posting!, text: "Changed" } }
          : {}),
      });
      f.store.put("task", clone.taskId, {
        ...task,
        id: clone.taskId,
        greenhousePull: { ...task.greenhousePull!, runId, candidateId: id },
        ...(variant === "legacy"
          ? {
              manifest: { ...task.manifest!, sourceHashes: {} },
              bundle: { ...task.bundle!, sourceHashes: {} },
            }
          : {}),
        ...(variant === "missing policy"
          ? {
              bundle: {
                ...task.bundle!,
                artifacts: task.bundle?.artifacts?.filter(
                  (item) => item.path !== reviewInputsFile,
                ),
              },
            }
          : {}),
      });
    }
    f.store.db.prepare("DELETE FROM migrations WHERE version=5").run();
    assert.deepEqual(backfillReviewMemory(f.store), {
      backfilled: 1,
      skipped: 5,
      alreadyApplied: false,
    });
    assert.deepEqual(backfillReviewMemory(f.store), {
      backfilled: 0,
      skipped: 0,
      alreadyApplied: true,
    });
    assert.equal(f.store.list(reviewMemoryKind).length, 1);
    assert.ok(
      f.store
        .list("journal")
        .some((entry) => entry.type === "greenhouse_review_memory_backfill"),
    );
  } finally {
    await f.close();
  }
});

test("rereview API requires CSRF and run ownership; active/finishing requeue, finalized only clears", async () => {
  const f = memoryFixture();
  let http: Awaited<ReturnType<typeof openFixtureWorkspace>> | undefined;
  try {
    await seed(f);
    const run = f.manager.start(10, "second");
    await f.exhaust();
    const candidate = f.manager.ledger(run.id).candidates[0];
    await f.manager.close();
    http = await openFixtureWorkspace(f.root, path.join(f.root, ".local/http"));
    for (const status of ["running", "finishing", "exhausted"] as const) {
      http.store.put("greenhouse_pull_run", run.id, { ...run, status });
      http.store.put("greenhouse_pull_candidate", candidate.id, candidate);
      const memory = f.store.list(reviewMemoryKind)[0];
      http.store.put(reviewMemoryKind, memory.id, memory);
      const route = `/api/greenhouse/pulls/${run.id}/candidates/${encodeURIComponent(candidate.id)}/rereview`;
      const response = await http.post(route);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.requeued, status !== "exhausted");
      assert.equal(
        result.candidate.state,
        status === "exhausted" ? "excluded" : "discovered",
      );
      if (result.requeued) {
        assert.equal(result.candidate.taskId, undefined);
        assert.equal(result.candidate.forceReview, true);
      }
      assert.equal(http.store.list(reviewMemoryKind).length, 0);
    }
    const wrong = await http.post(
      `/api/greenhouse/pulls/other/candidates/${encodeURIComponent(candidate.id)}/rereview`,
    );
    assert.equal(wrong.status, 404);
    const session = await http.get("/api/session");
    const base = new URL(session.url).origin;
    assert.equal(
      (
        await fetch(
          `${base}/api/greenhouse/pulls/${run.id}/candidates/${encodeURIComponent(candidate.id)}/rereview`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}",
          },
        )
      ).status,
      403,
    );
  } finally {
    await http?.close();
    await f.close();
  }
});

test("forced active re-review makes a fresh task instead of following the remembered task", async () => {
  const f = memoryFixture();
  try {
    await seed(f);
    const run = f.manager.start(10, "second");
    await f.tickUntil(() => f.manager.state()?.remembered === 1);
    const candidate = f.manager.ledger(run.id).candidates[0];
    assert.equal(
      rereviewCandidate(f.store, run.id, candidate.id).requeued,
      true,
    );
    await f.running();
    assert.equal(f.store.list("task").length, 2);
    assert.equal(f.manager.state()?.remembered, 0);
  } finally {
    await f.close();
  }
});

test("extra search terms and volatile timestamps do not invalidate an exclusion after 72 hours", async () => {
  const f = memoryFixture();
  try {
    await seed(f);
    f.controls.setTime(at + deferredReviewMemoryMs);
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseGuidance: {
        instructions: "",
        searchTerms: ["api engineer"],
        employmentScope: ["full_time"],
      },
    });
    f.controls.posting = (item) => ({
      ...posting(item),
      fetchedAt: new Date(f.controls.time()).toISOString(),
      raw: {
        ...posting(item).raw,
        updated_at: new Date(f.controls.time()).toISOString(),
      },
    });
    f.manager.start(10, "second");
    await f.exhaust();
    assert.equal(f.manager.state()?.remembered, 1);
    assert.equal(f.store.list("task").length, 1);
    assert.ok(
      f.manager
        .ledger(f.manager.latest()!.id)
        .run.activity.filter((entry) => entry.triagePage)
        .every((entry) => entry.text.includes("1 reviewed in earlier pulls")),
    );
  } finally {
    await f.close();
  }
});

test("deterministic technology screening still wins over memory and never replaces it", async () => {
  const f = memoryFixture();
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      fitCriteria: {
        ...f.store.settings().fitCriteria,
        technologyExcludeTerms: ["C#"],
      },
    });
    await seed(f);
    const memory = f.store.list(reviewMemoryKind)[0];
    f.controls.posting = (item) => ({
      ...posting(item),
      text: posting(item).text + " C# preferred.",
    });
    f.manager.start(10, "second");
    await f.exhaust();
    assert.equal(f.manager.state()?.remembered, 0);
    assert.equal(f.manager.state()?.excluded, 1);
    assert.equal(f.store.list("task").length, 1);
    assert.deepEqual(f.store.list(reviewMemoryKind), [memory]);
  } finally {
    await f.close();
  }
});

test("changing the employment scope starts a fresh review instead of reusing an old outcome", async () => {
  const f = memoryFixture();
  try {
    await seed(f);
    f.store.put("settings", "main", {
      ...f.store.settings(),
      greenhouseGuidance: {
        instructions: "",
        searchTerms: [],
        employmentScope: ["contract"],
      },
    });
    f.manager.start(10, "contract-scope");
    const task = await f.running();
    assert.equal(f.store.list("task").length, 2);
    assert.equal(f.manager.state()?.remembered, 0);
    assert.match(task.greenhousePull?.instructions ?? "", /Scope: Contract\./);
    assert.doesNotMatch(
      task.greenhousePull?.instructions ?? "",
      /Evaluate full-time W-2/,
    );
  } finally {
    await f.close();
  }
});
