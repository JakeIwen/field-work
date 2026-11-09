import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  at,
  card,
  posting,
  fixture,
  advanceUntil,
} from "./fixtures/greenhouse-pull-fixture.js";
import {
  greenhouseQueries,
  GreenhouseSearchTransient,
  searchUrl,
} from "../server/greenhouse-source.js";
import { prepareOpeningResearch } from "../server/opening-workflow.js";
import { greenhouseReviewInstructions } from "../server/greenhouse-research.js";
import { draftPath } from "../server/bundles.js";

async function ticks(f: ReturnType<typeof fixture>, count: number) {
  for (let i = 0; i < count; i++) await f.manager.tick();
}

test("three concurrent reviews finish out of order and never reserve beyond the target", async () => {
  const f = fixture();
  try {
    f.manager.start(3);
    await advanceUntil(
      f,
      () =>
        f.manager
          .state()!
          .reviews!.filter((review) => review.status === "running").length ===
        3,
    );
    assert.equal(
      f.manager.state()!.reviews!.filter((r) => r.status === "running").length,
      3,
    );
    await ticks(f, 3);
    assert.equal(f.store.list("task").length, 3);
    f.finish(false, "3");
    await f.manager.tick();
    assert.equal(f.manager.state()!.added, 1);
    assert.equal(f.manager.state()!.reviews!.length, 2);
    f.finish(false, "2");
    f.finish(false, "1");
    await ticks(f, 3);
    assert.equal(f.manager.state()!.added, 3);
    assert.equal(f.manager.state()!.status, "target_reached");
    assert.equal(f.calls.filter((c) => c.query).length, 4);
  } finally {
    await f.close();
  }
  const bounded = fixture();
  try {
    bounded.manager.start(2);
    await ticks(bounded, 8);
    assert.equal(bounded.store.list("task").length, 2);
    bounded.finish(false, "2");
    await ticks(bounded, 3);
    assert.equal(bounded.store.list("task").length, 2);
    bounded.finish();
    await ticks(bounded, 2);
    assert.equal(bounded.manager.state()!.added, 2);
    assert.equal(bounded.manager.state()!.pending, 1);
  } finally {
    await bounded.close();
  }
});

test("an exclusion frees a review slot while the other reviews continue", async () => {
  const f = fixture({
    page: async (query, page, employmentTypes) => ({
      query,
      page,
      cards: [card("1"), card("2"), card("3"), card("4")],
      more: false,
      employmentTypes,
      url: searchUrl(query, page, employmentTypes),
      at: new Date(at).toISOString(),
      status: 200,
    }),
  });
  try {
    f.manager.start(3);
    await advanceUntil(
      f,
      () =>
        f.manager
          .state()!
          .reviews!.filter((review) => review.status === "running").length ===
        3,
    );
    f.finish(true, "2");
    await advanceUntil(
      f,
      () =>
        f.manager
          .state()!
          .reviews!.filter((review) => review.status === "running").length ===
        3,
    );
    assert.equal(f.manager.state()!.excluded, 1);
    assert.equal(f.manager.state()!.reviews!.length, 3);
    assert.equal(f.store.list("task").length, 4);
    assert.equal(f.manager.state()!.added, 0);
  } finally {
    await f.close();
  }
});

test("pause, restart and stop account for every review and preserve staged results", async () => {
  const f = fixture();
  try {
    const run = f.manager.start(3);
    await advanceUntil(
      f,
      () =>
        f.manager
          .state()!
          .reviews!.filter((review) => review.status === "running").length ===
        3,
    );
    f.manager.action(run.id, "pause");
    f.finish(false, "3");
    await ticks(f, 2);
    assert.equal(f.manager.state()!.added, 0);
    await f.restart();
    assert.equal(f.manager.state()!.status, "paused");
    f.manager.action(run.id, "resume");
    await f.manager.tick();
    assert.equal(f.manager.state()!.added, 1);
    f.manager.action(run.id, "stop", true);
    assert.equal(f.calls.filter((c) => c.interrupt).length, 2);
    assert.equal(
      f.store.list("task").filter((t) => t.status === "interrupted").length,
      2,
    );
    await f.manager.tick();
    assert.equal(f.manager.state()!.added, 1);
  } finally {
    await f.close();
  }
});

test("resume retries all interrupted reviews without discarding captured postings or attempts", async () => {
  const f = fixture();
  try {
    const run = f.manager.start(3);
    await advanceUntil(
      f,
      () =>
        f.manager
          .state()!
          .reviews!.filter((review) => review.status === "running").length ===
        3,
    );
    f.manager.action(run.id, "pause");
    for (const task of f.store.list("task"))
      f.store.put("task", task.id, { ...task, status: "interrupted" });
    await f.restart();
    f.manager.action(run.id, "resume");
    await advanceUntil(
      f,
      () =>
        f.manager
          .state()!
          .reviews!.filter((review) => review.status === "running").length ===
        3,
    );
    assert.equal(f.manager.state()!.reviews!.length, 3);
    assert.equal(f.store.list("task").length, 6);
    assert.equal(f.calls.filter((c) => c.posting).length, 3);
    assert.ok(
      f.manager
        .ledger(run.id)
        .candidates.every((c) => c.attempts?.length === 1 && c.posting),
    );
  } finally {
    await f.close();
  }
});

test("requisition aliases wait for an in-flight review and publication deduplicates them", async () => {
  const f = fixture({
    posting: async (c) => ({
      ...posting(c),
      aliases: c.id === "3" ? ["3"] : ["1", "2"],
      raw: {
        ...posting(c).raw,
        internal_job_id: c.id === "3" ? "different" : "shared",
      },
    }),
  });
  try {
    f.manager.start(2);
    await ticks(f, 8);
    assert.equal(f.store.list("task").length, 2);
    assert.deepEqual(
      f.store
        .list("greenhouse_pull_candidate")
        .filter((c) => c.taskId)
        .map((c) => c.card.id)
        .sort(),
      ["1", "3"],
    );
    f.finish(false, "1");
    await ticks(f, 2);
    assert.equal(
      f.manager.state()!.existing,
      0,
      "target reservations can defer duplicate cleanup until a slot is available",
    );
    f.finish(true, "3");
    await advanceUntil(f, () => f.manager.state()!.existing === 1);
    assert.equal(f.manager.state()!.existing, 1);
    assert.equal(f.manager.state()!.added, 1);
  } finally {
    await f.close();
  }
});

test("search capture failures retain the exact page and increase persistent cooldown and pacing", async () => {
  let attempts = 0;
  const f = fixture({
    page: async (query, page, employmentTypes) => {
      f.calls.push({ query, page });
      attempts++;
      throw new GreenhouseSearchTransient("response body unavailable");
    },
  });
  try {
    const run = f.manager.start();
    await f.manager.tick();
    assert.equal(f.manager.state()!.status, "cooldown");
    assert.equal(f.manager.ledger(run.id).run.limitCount, 1);
    await f.restart();
    f.manager.action(run.id, "resume");
    await f.manager.tick();
    assert.equal(attempts, 1);
    for (let retry = 0; retry < 3; retry++) {
      f.setTime(Date.parse(f.manager.latest()!.retryAt!));
      await f.manager.tick();
    }
    assert.equal(attempts, 4);
    assert.equal(f.manager.state()!.status, "cooldown");
    assert.equal(f.manager.state()!.pacingRate, 6000);
    assert.match(f.manager.state()!.phase, /slower interval/);
    assert.equal(f.manager.ledger(run.id).run.pages.length, 0);
    assert.ok(
      f.calls.every(
        (call) => call.query === greenhouseQueries[0] && call.page === 1,
      ),
    );
    f.manager.action(run.id, "resume");
    await f.manager.tick();
    assert.equal(f.manager.ledger(run.id).run.searchRetry, undefined);
    assert.equal(attempts, 4);
  } finally {
    await f.close();
  }
});

test("successful search recovery keeps slower pacing and records a page only once", async () => {
  let attempts = 0;
  const f = fixture({
    page: async (query, page, employmentTypes) => {
      if (++attempts < 3) throw new GreenhouseSearchTransient("empty body");
      return {
        query,
        page,
        cards: [card("1")],
        more: false,
        employmentTypes,
        url: searchUrl(query, page, employmentTypes),
        at: new Date(at).toISOString(),
        status: 200,
      };
    },
  });
  try {
    const run = f.manager.start(1);
    await f.manager.tick();
    f.setTime(Date.parse(f.manager.latest()!.retryAt!));
    await f.manager.tick();
    f.setTime(Date.parse(f.manager.latest()!.retryAt!));
    await f.manager.tick();
    assert.equal(f.manager.state()!.status, "running");
    assert.equal(f.manager.ledger(run.id).run.searchRetry, undefined);
    assert.equal(f.manager.ledger(run.id).run.pages.length, 1);
    assert.equal(f.manager.state()!.discovered, 1);
  } finally {
    await f.close();
  }
});

test("default stop lets existing reviews publish and record exclusions, even after a new pull starts", async () => {
  const f = fixture();
  try {
    const run = f.manager.start(3);
    await advanceUntil(
      f,
      () =>
        f.manager
          .state()!
          .reviews!.filter((review) => review.status === "running").length ===
        3,
    );
    f.manager.action(run.id, "stop");
    assert.equal(f.calls.filter((call) => call.interrupt).length, 0);
    f.finish(false, "1");
    f.finish(true, "2");
    await ticks(f, 2);
    assert.equal(f.manager.state()!.status, "finishing");
    assert.equal(f.manager.state()!.added, 1);
    assert.equal(f.manager.state()!.excluded, 1);
    const next = f.manager.start(1);
    f.finish(false, "3");
    await f.manager.tick();
    const old = f.manager.ledger(run.id);
    assert.equal(old.run.status, "stopped");
    assert.equal(
      old.candidates.filter((candidate) => candidate.state === "added").length,
      2,
    );
    assert.equal(f.manager.latest()!.id, next.id);
    assert.equal(
      f.store.list("task").length,
      3,
      "no new candidate work was started for the stopped pull",
    );
  } finally {
    await f.close();
  }
});

test("a stopped review rejected by provider guards cannot fail a newer pull", async () => {
  const f = fixture();
  try {
    const run = f.manager.start(1);
    await advanceUntil(
      f,
      () =>
        f.manager
          .state()!
          .reviews!.some((review) => review.status === "running") === true,
    );
    f.manager.action(run.id, "stop");
    const candidate = f.finish();
    const captured = f.store.get("greenhouse_pull_candidate", candidate.id);
    assert.ok(captured);
    f.store.put("greenhouse_pull_candidate", candidate.id, {
      ...captured,
      card: { ...candidate.card, provider: "ashby" },
    });
    const next = f.manager.start(1);
    await f.manager.tick();
    assert.equal(f.manager.latest()!.id, next.id);
    assert.equal(f.manager.latest()!.status, "running");
    const saved = f.manager.ledger(run.id).candidates[0];
    assert.equal(saved.state, "deferred");
    assert.match(saved.reason!, /retired pull source/);
  } finally {
    await f.close();
  }
});

test("stopped reviews keep publication freshness and receipt guards across restart", async () => {
  const f = fixture();
  try {
    const run = f.manager.start(1);
    await advanceUntil(
      f,
      () =>
        f.manager
          .state()!
          .reviews!.some((review) => review.status === "running") === true,
    );
    f.manager.action(run.id, "stop");
    await f.restart();
    f.finish();
    f.setTime(at + 7 * 86400000);
    await advanceUntil(f, () => f.manager.state()!.status === "stopped");
    assert.equal(f.manager.state()!.status, "stopped");
    assert.equal(f.manager.state()!.added, 0);
    assert.equal(f.manager.state()!.excluded, 3);
  } finally {
    await f.close();
  }
});

test("research bundles retain evidence while keeping duplicate posting prose out of metadata", async () => {
  const f = fixture();
  try {
    f.manager.start(1);
    await ticks(f, 2);
    const candidate = f.store.list("greenhouse_pull_candidate")[0];
    candidate.posting!.raw.content = "<p>Duplicate full posting</p>";
    const task = {
      ...f.store.get("task", candidate.taskId!)!,
      id: randomUUID(),
      greenhousePull: {
        runId: candidate.runId,
        candidateId: candidate.id,
        candidate,
        instructions: greenhouseReviewInstructions,
      },
      posting: {
        text: candidate.posting!.text,
        fetchedAt: candidate.posting!.fetchedAt,
      },
    };
    const { manifest } = prepareOpeningResearch(f.store, task);
    const metadata = JSON.parse(
      readFileSync(
        draftPath(f.store, task.id, "greenhouse-candidate.json"),
        "utf8",
      ),
    );
    assert.equal(
      metadata.posting.raw.first_published,
      candidate.posting!.raw.first_published,
    );
    assert.equal(metadata.posting.apiUrl, candidate.posting!.apiUrl);
    assert.equal(metadata.posting.raw.content, undefined);
    assert.equal(metadata.posting.text, undefined);
    assert.match(
      readFileSync(draftPath(f.store, task.id, "job-posting.txt"), "utf8"),
      /Build and maintain React/,
    );
    assert.ok(manifest.paths.includes("github-evidence.md"));
    assert.equal(
      candidate.posting!.raw.content,
      "<p>Duplicate full posting</p>",
    );
  } finally {
    await f.close();
  }
});
