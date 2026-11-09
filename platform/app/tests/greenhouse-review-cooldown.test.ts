import test from "node:test";
import assert from "node:assert/strict";
import {
  at,
  fixture,
  advanceUntil,
} from "./fixtures/greenhouse-pull-fixture.js";
import { GreenhouseLimit } from "../server/greenhouse-source.js";
import type { ModelSelection } from "../shared/model-selection.js";

const capacity = "Selected model is at capacity. Please try a different model.";

test("creation capacity waits without failing, keeps searches and running reviews progressing, then retries", async () => {
  const f = fixture();
  let attempts = 0;
  const create = f.review.createResearch;
  f.review.createResearch = async (run, candidate) => {
    if (++attempts === 2) throw Error(capacity);
    return create(run, candidate);
  };
  try {
    const run = f.manager.start(3);
    await advanceUntil(f, () =>
      Boolean(f.manager.ledger(run.id).run.reviewCooldown),
    );
    const ledger = f.manager.ledger(run.id);
    assert.equal(ledger.run.status, "running");
    assert.equal(ledger.run.error, undefined);
    assert.equal(ledger.run.retryAt, undefined);
    assert.equal(
      ledger.run.reviewCooldown?.retryAt,
      new Date(at + 60000).toISOString(),
    );
    assert.equal(
      ledger.run.failures.at(-1)?.candidateId,
      ledger.run.reviewCooldown?.candidateId,
    );
    const capacityLine = [...(ledger.run.activity ?? [])]
      .reverse()
      .find((entry) => entry.lane === "review" && entry.level === "warn");
    assert.match(
      capacityLine?.text ?? "",
      /^Codex model at capacity: .+ waits 60 s$/,
    );
    assert.equal(
      capacityLine?.candidateId,
      ledger.run.reviewCooldown?.candidateId,
    );
    assert.equal(
      ledger.candidates.find(
        (c) => c.id === ledger.run.reviewCooldown?.candidateId,
      )?.state,
      "discovered",
    );
    assert.match(
      f.manager.state()?.phase ?? "",
      /review starts.*retry after.*same model/i,
    );
    const pages = ledger.run.pages.length;
    f.finish(false, "1");
    await f.manager.tick();
    assert.equal(f.manager.state()?.added, 1);
    await f.manager.tick();
    assert.ok(f.manager.ledger(run.id).run.pages.length > pages);
    assert.equal(attempts, 2);
    assert.equal(
      f.manager.ledger(run.id).run.pacingRate,
      ledger.run.pacingRate,
    );
    f.setTime(at + 60000);
    await advanceUntil(f, () => !f.manager.ledger(run.id).run.reviewCooldown);
    assert.equal(attempts, 3);
    assert.equal(f.manager.state()?.status, "running");
    f.finish(false, "2");
    await f.manager.tick();
    await advanceUntil(f, () =>
      f.store.list("task").some((t) => t.status === "running"),
    );
    f.finish(false, "3");
    await f.manager.tick();
    assert.equal(f.manager.state()?.status, "target_reached");
    assert.equal(f.manager.state()?.added, 3);
  } finally {
    await f.close();
  }
});

test("a failed start keeps its task, selected model and effort through cooldown and changed defaults", async () => {
  const f = fixture();
  const choices: Partial<ModelSelection>[] = [];
  const start = f.review.startTask;
  f.review.startTask = async (id, selection) => {
    choices.push(selection ?? {});
    if (choices.length === 1) throw Error("HTTP 429: rate limit exceeded");
    return start(id, selection);
  };
  try {
    f.store.put("settings", "main", {
      ...f.store.settings(),
      codexModels: { "greenhouse-pull": "fixture-original" },
      codexEfforts: { "greenhouse-pull": "xhigh" },
    });
    const run = f.manager.start(1);
    await advanceUntil(f, () =>
      Boolean(f.manager.ledger(run.id).run.reviewCooldown),
    );
    const candidate = f.manager.ledger(run.id).candidates.find((c) => c.taskId);
    assert.ok(candidate?.taskId);
    assert.equal(f.store.get("task", candidate.taskId)?.status, "handoff");
    f.store.put("settings", "main", {
      ...f.store.settings(),
      codexModels: { "greenhouse-pull": "fixture-other" },
      codexEfforts: { "greenhouse-pull": "high" },
    });
    await f.manager.tick();
    assert.equal(choices.length, 1);
    f.setTime(at + 60000);
    await advanceUntil(f, () => !f.manager.ledger(run.id).run.reviewCooldown);
    assert.deepEqual(choices, [
      { model: "fixture-original", effort: "xhigh" },
      { model: "fixture-original", effort: "xhigh" },
    ]);
    assert.equal(f.store.list("task").length, 1);
    assert.equal(f.store.get("task", candidate.taskId)?.status, "running");
    assert.equal(f.manager.state()?.status, "running");
  } finally {
    await f.close();
  }
});

test("adapter-returned capacity failures cool down and survive pause/restart", async () => {
  const f = fixture();
  const start = f.review.startTask;
  let starts = 0;
  f.review.startTask = async (id, selection) => {
    if (++starts !== 1) return start(id, selection);
    const task = f.store.get("task", id);
    assert.ok(task);
    f.store.put("task", id, {
      ...task,
      status: "unavailable",
      error: "API Error: 529 overloaded_error",
    });
    return f.store.get("task", id);
  };
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () =>
      Boolean(f.manager.ledger(run.id).run.reviewCooldown),
    );
    assert.equal(f.manager.state()?.status, "running");
    const cooldown = f.manager.ledger(run.id).run.reviewCooldown;
    await f.restart();
    assert.equal(f.manager.state()?.status, "paused");
    f.manager.action(run.id, "resume");
    await f.manager.tick();
    assert.equal(starts, 1);
    assert.deepEqual(f.manager.ledger(run.id).run.reviewCooldown, cooldown);
    assert.equal(
      f.store.personalExport().records.greenhouse_pull_run[0]?.reviewCooldown
        ?.retryAt,
      cooldown?.retryAt,
    );
    f.setTime(at + 60000);
    await advanceUntil(f, () => !f.manager.ledger(run.id).run.reviewCooldown);
    assert.equal(starts, 2);
    assert.equal(f.manager.state()?.status, "running");
  } finally {
    await f.close();
  }
});

test("capacity after thread creation preserves the failed attempt and retries without starting that thread twice", async () => {
  const f = fixture();
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () =>
      f.store.list("task").some((t) => t.status === "running"),
    );
    const task = f.store.list("task")[0];
    assert.ok(task?.threadId);
    f.store.put("task", task.id, {
      ...task,
      model: "fixture-confirmed",
      effort: "high",
      status: "disconnected",
      error: "Temporarily overloaded. Try again later.",
    });
    await f.manager.tick();
    const ledger = f.manager.ledger(run.id);
    assert.equal(ledger.run.status, "running");
    const candidate = ledger.candidates.find(
      (c) => c.id === ledger.run.reviewCooldown?.candidateId,
    );
    assert.ok(candidate);
    assert.equal(candidate.taskId, undefined);
    assert.deepEqual(candidate.attempts, [task.id]);
    f.setTime(at + 60000);
    await advanceUntil(f, () => !f.manager.ledger(run.id).run.reviewCooldown);
    const retried = f.manager
      .ledger(run.id)
      .candidates.find((c) => c.id === candidate.id);
    assert.ok(retried?.taskId);
    assert.notEqual(retried.taskId, task.id);
    assert.equal(f.store.get("task", task.id)?.status, "disconnected");
    assert.equal(
      f.store.get("task", retried.taskId)?.model,
      "fixture-confirmed",
    );
    assert.equal(f.store.get("task", retried.taskId)?.status, "running");
  } finally {
    await f.close();
  }
});

test("consecutive capacity failures double to ten minutes and a real start resets the backoff", async () => {
  const f = fixture();
  const create = f.review.createResearch;
  let reject = true;
  f.review.createResearch = async (run, candidate) => {
    if (reject) throw Error(capacity);
    return create(run, candidate);
  };
  try {
    const run = f.manager.start(3);
    let time = at;
    for (const [index, delay] of [60, 120, 240, 480, 600, 600].entries()) {
      await advanceUntil(
        f,
        () =>
          f.manager.ledger(run.id).run.reviewCooldown?.failures === index + 1,
      );
      const saved = f.manager.ledger(run.id).run;
      assert.equal(saved.status, "running");
      assert.equal(
        Date.parse(saved.reviewCooldown?.retryAt ?? "") - time,
        delay * 1000,
      );
      time += delay * 1000;
      f.setTime(time);
    }
    reject = false;
    await advanceUntil(f, () => !f.manager.ledger(run.id).run.reviewCooldown);
    reject = true;
    await advanceUntil(f, () =>
      Boolean(f.manager.ledger(run.id).run.reviewCooldown),
    );
    assert.equal(f.manager.ledger(run.id).run.reviewCooldown?.failures, 1);
    assert.equal(
      Date.parse(f.manager.ledger(run.id).run.reviewCooldown?.retryAt ?? "") -
        time,
      60000,
    );
  } finally {
    await f.close();
  }
});

for (const message of [
  "Saved context is missing",
  "Selected model is unavailable",
  "Invalid prompt about capacity planning",
  "Invalid document 429",
]) {
  test(`non-capacity review creation errors still fail the pull: ${message}`, async () => {
    const f = fixture();
    f.review.createResearch = async () => {
      throw Error(message);
    };
    try {
      const run = f.manager.start(1);
      await advanceUntil(f, () => f.manager.state()?.status === "failed");
      assert.equal(f.manager.ledger(run.id).run.reviewCooldown, undefined);
      assert.ok(f.manager.state()?.error?.includes(message));
    } finally {
      await f.close();
    }
  });
}

test("posting HTTP limits remain source cooldowns, not agent capacity cooldowns", async () => {
  const f = fixture({
    posting: async () => {
      throw new GreenhouseLimit(
        "HTTP 429",
        new Date(at + 120000).toISOString(),
      );
    },
  });
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () => f.manager.state()?.status === "cooldown");
    assert.equal(f.manager.ledger(run.id).run.reviewCooldown, undefined);
    assert.equal(
      f.manager.ledger(run.id).run.retryAt,
      new Date(at + 120000).toISOString(),
    );
  } finally {
    await f.close();
  }
});

test("the resolved default model stays pinned after later catalog/default preference changes", async () => {
  const f = fixture();
  let defaultModel: string | undefined;
  f.review.defaultModel = () => defaultModel;
  const start = f.review.startTask;
  let starts = 0;
  f.review.startTask = async (id, selection) => {
    if (++starts === 1) {
      defaultModel = "fixture-resolved-default";
      throw Error(capacity);
    }
    assert.equal(selection?.model, "fixture-resolved-default");
    return start(id, selection);
  };
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () =>
      Boolean(f.manager.ledger(run.id).run.reviewCooldown),
    );
    defaultModel = "fixture-new-recommendation";
    f.store.put("settings", "main", {
      ...f.store.settings(),
      codexModels: { "greenhouse-pull": "fixture-changed-preference" },
    });
    f.setTime(at + 60000);
    await advanceUntil(f, () => !f.manager.ledger(run.id).run.reviewCooldown);
    assert.equal(starts, 2);
  } finally {
    await f.close();
  }
});

test("stopping discovery does not bypass a reserved review's cooldown or block a new pull", async () => {
  const f = fixture();
  const start = f.review.startTask;
  let starts = 0;
  f.review.startTask = async (id, selection) => {
    if (++starts === 1) throw Error(capacity);
    return start(id, selection);
  };
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () =>
      Boolean(f.manager.ledger(run.id).run.reviewCooldown),
    );
    f.manager.action(run.id, "stop");
    const next = f.manager.start(1);
    await f.manager.tick();
    assert.equal(starts, 1);
    assert.equal(f.manager.ledger(next.id).run.pages.length, 1);
    f.setTime(at + 60000);
    await f.manager.tick();
    assert.equal(starts, 2);
    assert.equal(f.manager.ledger(run.id).run.reviewCooldown, undefined);
    f.finish(false, "1");
    await f.manager.tick();
    assert.equal(
      f.manager.ledger(run.id).candidates.filter((c) => c.state === "added")
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("an unchanged queued task is not a successful review start and does not reset backoff", async () => {
  const f = fixture();
  let starts = 0;
  f.review.startTask = async (id) => {
    if (++starts === 1) throw Error(capacity);
    return f.store.get("task", id);
  };
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () =>
      Boolean(f.manager.ledger(run.id).run.reviewCooldown),
    );
    const cooldown = f.manager.ledger(run.id).run.reviewCooldown;
    f.setTime(at + 60000);
    await f.manager.tick();
    assert.equal(starts, 2);
    assert.deepEqual(f.manager.ledger(run.id).run.reviewCooldown, cooldown);
  } finally {
    await f.close();
  }
});

test("non-capacity saved start failures retain the existing attention behavior", async () => {
  const f = fixture();
  f.review.startTask = async (id) => {
    const task = f.store.get("task", id);
    assert.ok(task);
    f.store.put("task", id, {
      ...task,
      status: "failed",
      error: "Saved model is unavailable",
    });
    return f.store.get("task", id);
  };
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () => f.manager.state()?.status === "failed");
    assert.equal(f.manager.ledger(run.id).run.reviewCooldown, undefined);
    assert.match(f.manager.state()?.error ?? "", /Saved model is unavailable/);
  } finally {
    await f.close();
  }
});

test("a stopped reserved review retains capacity retries even when a failed attempt created a thread", async () => {
  const f = fixture();
  const start = f.review.startTask;
  let starts = 0;
  f.review.startTask = async (id, selection) => {
    starts++;
    if (starts === 1) throw Error(capacity);
    if (starts === 2) {
      const task = f.store.get("task", id);
      assert.ok(task);
      f.store.put("task", id, {
        ...task,
        threadId: "rejected-thread",
        status: "failed",
        error: capacity,
      });
      return f.store.get("task", id);
    }
    return start(id, selection);
  };
  try {
    const run = f.manager.start(1);
    await advanceUntil(f, () =>
      Boolean(f.manager.ledger(run.id).run.reviewCooldown),
    );
    f.manager.action(run.id, "stop");
    f.setTime(at + 60000);
    await f.manager.tick();
    assert.equal(f.manager.ledger(run.id).run.reviewCooldown?.failures, 2);
    assert.equal(f.manager.ledger(run.id).run.status, "finishing");
    await f.manager.tick();
    assert.equal(starts, 2);
    f.setTime(at + 180000);
    await advanceUntil(f, () => starts === 3);
    f.finish(false, "1");
    await f.manager.tick();
    assert.equal(
      f.manager.ledger(run.id).candidates.filter((c) => c.state === "added")
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});

test("an uncertain capacity error never duplicates a live thread or starves other reviews", async () => {
  const f = fixture();
  const start = f.review.startTask;
  let starts = 0;
  f.review.startTask = async (id, selection) => {
    const result = await start(id, selection);
    if (++starts === 3) throw Error(capacity);
    return result;
  };
  try {
    const run = f.manager.start(3);
    await advanceUntil(f, () =>
      Boolean(f.manager.ledger(run.id).run.reviewCooldown),
    );
    f.finish(false, "1");
    await f.manager.tick();
    assert.equal(f.manager.state()?.added, 1);
    f.setTime(at + 60000);
    f.finish(false, "2");
    await f.manager.tick();
    assert.equal(f.manager.state()?.added, 2);
    assert.equal(starts, 3);
    f.finish(false, "3");
    await f.manager.tick();
    assert.equal(f.manager.state()?.status, "target_reached");
  } finally {
    await f.close();
  }
});
