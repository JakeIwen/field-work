import test from "node:test";
import assert from "node:assert/strict";
import {
  fixture,
  advanceUntil,
  card,
  at,
} from "./fixtures/greenhouse-pull-fixture.js";
import { searchUrl, GreenhouseLimit } from "../server/greenhouse-source.js";
import { greenhouseActivityLane } from "../shared/greenhouse-pull.js";

function finishingFixture(count = 9) {
  let searches = 0;
  let closes = 0;
  const f = fixture({
    page: async (query, page, employmentTypes) => {
      searches++;
      return {
        query,
        page,
        cards: Array.from({ length: count }, (_, index) =>
          card(String(index + 1)),
        ),
        more: true,
        status: 200,
        employmentTypes,
        url: searchUrl(query, page, employmentTypes),
        at: new Date(at).toISOString(),
      };
    },
    close: async () => {
      closes++;
    },
  });
  return { f, searches: () => searches, closes: () => closes };
}
const running = (f: ReturnType<typeof fixture>) =>
  f.store.list("task").filter((task) => task.status === "running").length;
async function drain(f: ReturnType<typeof fixture>, runId: string) {
  for (
    let tick = 0;
    tick < 150 && f.manager.ledger(runId).run.status === "finishing";
    tick++
  ) {
    if (running(f)) f.finish();
    await f.manager.tick();
    assert.ok(running(f) <= 6);
  }
  assert.notEqual(f.manager.ledger(runId).run.status, "finishing");
}

test("target completion drains the discovered backlog beyond the target without more searches", async () => {
  const { f, searches, closes } = finishingFixture();
  try {
    const run = f.manager.start(2);
    await advanceUntil(f, () => running(f) === 2);
    assert.equal(
      f.store.list("task").length,
      2,
      "pre-target reservations remain bounded by the target",
    );
    f.finish(false, "1");
    await f.manager.tick();
    f.finish(false, "2");
    await f.manager.tick();
    assert.equal(f.manager.state()!.status, "finishing");
    assert.equal(f.manager.state()!.pending, 7);
    assert.equal(
      f.manager.state()!.phase,
      "Target reached; finishing 7 reviews",
    );
    assert.ok(
      f.manager
        .state()!
        .activity!.some(
          (entry) =>
            entry.lane === greenhouseActivityLane.search &&
            entry.text === "Target reached; finishing 7 reviews",
        ),
    );
    await advanceUntil(f, () => running(f) === 6);
    assert.equal(f.manager.state()!.pending, 7);
    assert.equal(searches(), 1);
    assert.equal(closes(), 0);
    await drain(f, run.id);
    assert.equal(f.manager.state()!.status, "target_reached");
    assert.equal(f.manager.state()!.added, 9);
    assert.equal(f.manager.state()!.pending, 0);
    assert.equal(searches(), 1);
    await f.manager.tick();
    assert.equal(closes(), 1);
  } finally {
    await f.close();
  }
});

test("Stop finishes queued and in-progress reviews while allowing a new pull", async () => {
  const { f, searches, closes } = finishingFixture(8);
  try {
    const run = f.manager.start(10);
    await advanceUntil(f, () => running(f) === 1);
    f.manager.action(run.id, "stop");
    assert.equal(f.manager.state()!.status, "finishing");
    assert.equal(f.manager.state()!.pending, 8);
    assert.ok(
      f.manager
        .state()!
        .activity!.some(
          (entry) =>
            entry.lane === greenhouseActivityLane.search &&
            entry.text === "Stopped searching; finishing 8 reviews",
        ),
    );
    const next = f.manager.start(1);
    assert.notEqual(next.id, run.id);
    f.manager.action(next.id, "stop_reviews");
    await advanceUntil(f, () => running(f) === 6);
    assert.equal(
      closes(),
      0,
      "an older finishing queue remains active even when the newest run is stopped",
    );
    assert.equal(f.manager.hasWork(), true);
    await drain(f, run.id);
    const old = f.manager.ledger(run.id);
    assert.equal(old.run.status, "stopped");
    assert.equal(
      old.candidates.filter((candidate) => candidate.state === "added").length,
      8,
    );
    assert.equal(searches(), 1);
    assert.equal(f.manager.hasWork(), false);
  } finally {
    await f.close();
  }
});

test("stop_reviews interrupts current reviews and leaves queued candidates discovered, including the legacy option", async () => {
  for (const legacy of [false, true]) {
    const { f, searches } = finishingFixture();
    try {
      const run = f.manager.start(10);
      await advanceUntil(f, () => running(f) === 6);
      f.manager.action(run.id, "stop");
      const stopped = f.manager.action(
        run.id,
        legacy ? "stop" : "stop_reviews",
        legacy,
      );
      assert.equal(stopped.status, "stopped");
      assert.equal(stopped.finishReviews, false);
      assert.equal(f.calls.filter((call) => call.interrupt).length, 6);
      assert.equal(
        f.store
          .list("greenhouse_pull_candidate")
          .filter((candidate) => candidate.state === "discovered").length,
        3,
      );
      assert.ok(
        stopped.activity!.some(
          (entry) =>
            entry.lane === greenhouseActivityLane.review &&
            entry.text === "Stopped 9 reviews",
        ),
      );
      for (let tick = 0; tick < 10; tick++) await f.manager.tick();
      assert.equal(f.store.list("task").length, 6);
      assert.equal(searches(), 1);
    } finally {
      await f.close();
    }
  }
});

test("an older finishing pull can stop its reviews without stopping a newer search", async () => {
  const { f } = finishingFixture();
  try {
    const run = f.manager.start(10);
    await advanceUntil(f, () => running(f) === 1);
    f.manager.action(run.id, "stop");
    const next = f.manager.start(1);
    f.manager.action(run.id, "stop_reviews");
    assert.equal(f.manager.latest()!.id, next.id);
    assert.equal(f.manager.latest()!.status, "running");
    await advanceUntil(f, () => f.manager.latest()!.pages.length === 1);
    assert.equal(f.manager.latest()!.pages.length, 1);
    assert.equal(
      f.manager
        .ledger(run.id)
        .candidates.filter((candidate) => candidate.state === "discovered")
        .length,
      8,
    );
  } finally {
    await f.close();
  }
});

test("finishing queues keep model-capacity cooldown and posting retry guards across restart", async () => {
  const { f, searches } = finishingFixture(3);
  const create = f.review.createResearch;
  let capacity = true;
  f.review.createResearch = async (run, candidate) => {
    if (run.finishReason && capacity) {
      capacity = false;
      throw Error("model at capacity");
    }
    return create(run, candidate);
  };
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () => running(f) === 1);
    f.finish();
    await f.manager.tick();
    await advanceUntil(f, () => Boolean(f.manager.latest()!.reviewCooldown));
    const retryAt = f.manager.latest()!.reviewCooldown!.retryAt;
    assert.equal(f.manager.latest()!.status, "finishing");
    assert.equal(searches(), 1);
    await f.restart();
    assert.equal(f.manager.latest()!.status, "finishing");
    f.setTime(Date.parse(retryAt));
    await drain(f, run.id);
    assert.equal(f.manager.state()!.status, "target_reached");
    assert.equal(f.manager.state()!.added, 3);
    assert.equal(f.manager.state()!.pacingRate, 2000);
  } finally {
    await f.close();
  }
});

test("retired-source runs cannot hold workspace idle checks open", async () => {
  const { f } = finishingFixture();
  try {
    const run = f.manager.start();
    f.store.put("greenhouse_pull_run", run.id, {
      ...run,
      providers: ["ashby"],
      status: "running",
    });
    assert.equal(f.manager.state()!.status, "paused");
    assert.equal(f.manager.hasWork(), false);
    f.store.put("greenhouse_pull_run", run.id, {
      ...run,
      providers: ["greenhouse"],
      status: "finishing",
      finishReviews: true,
      finishReason: "stop",
    });
    assert.equal(f.manager.hasWork(), true);
  } finally {
    await f.close();
  }
});

test("stopping reviews during queued task creation leaves that candidate discovered", async () => {
  const { f } = finishingFixture(3);
  const create = f.review.createResearch;
  let release!: () => void;
  let begin!: () => void;
  const started = new Promise<void>((resolve) => {
    begin = resolve;
  });
  f.review.createResearch = async (run, candidate) => {
    if (run.finishReason) {
      begin();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return create(run, candidate);
  };
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () => running(f) === 1);
    f.finish();
    await f.manager.tick();
    const pending = f.manager.tick();
    await started;
    assert.equal(typeof release, "function");
    f.manager.action(run.id, "stop_reviews");
    release();
    await pending;
    assert.equal(
      f.manager
        .ledger(run.id)
        .candidates.filter((candidate) => candidate.state === "discovered")
        .length,
      2,
    );
    for (let tick = 0; tick < 4; tick++) await f.manager.tick();
    assert.equal(running(f), 0);
  } finally {
    await f.close();
  }
});

test("finishing posting limits retain the candidate and automatically retry without searching", async () => {
  let limited = false;
  const { f, searches } = finishingFixture(3);
  const original = f.review.source.posting;
  f.review.source.posting = async (candidate) => {
    if (candidate.id === "2" && !limited) {
      limited = true;
      throw new GreenhouseLimit(
        "Posting HTTP 429",
        new Date(at + 120000).toISOString(),
      );
    }
    return original(candidate);
  };
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () => running(f) === 1);
    f.finish();
    await f.manager.tick();
    await advanceUntil(f, () => Boolean(f.manager.latest()!.retryAt));
    assert.equal(f.manager.state()!.status, "finishing");
    assert.equal(f.manager.state()!.deferred, 0);
    f.setTime(Date.parse(f.manager.latest()!.retryAt!));
    await drain(f, run.id);
    assert.equal(f.manager.state()!.added, 3);
    assert.equal(f.manager.state()!.retryAt, undefined);
    assert.equal(searches(), 1);
  } finally {
    await f.close();
  }
});
