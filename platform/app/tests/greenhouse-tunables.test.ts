import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import {
  fixture,
  at,
  advanceUntil,
  card,
} from "./fixtures/greenhouse-pull-fixture.js";
import { legacyOpening } from "./fixtures/legacy-records.js";
import type { TunableSettings } from "../shared/tunables.js";
import { tunable, tunableMs } from "../server/tunables.js";
import { GreenhousePullLoop } from "../server/greenhouse-pull-loop.js";
import { GreenhouseBridgeTransient } from "../server/greenhouse-source.js";
import {
  recordGreenhousePacingIncrease,
  recordGreenhousePacingRecovery,
} from "../server/greenhouse-pacing.js";
import {
  OpeningValidationManager,
  inspectPosting,
} from "../server/opening-validation.js";
import { greenhouseCardDisposition } from "../server/opening-pull/card-triage.js";

function overrides(
  f: ReturnType<typeof fixture>,
  values: NonNullable<TunableSettings["tunables"]>,
) {
  f.store.put("settings", "main", {
    ...f.store.settings(),
    tunables: { ...f.store.settings().tunables, ...values },
  });
}

test("scheduler reads the interval each tick and the burst limit each wake", async (t) => {
  const f = fixture();
  t.mock.timers.enable({ apis: ["setInterval"] });
  overrides(f, {
    "greenhouse.loopIntervalMs": 250,
    "greenhouse.burstSteps": 2,
  });
  let steps = 0;
  const loop = new GreenhousePullLoop(
    async () => {
      steps++;
      return true;
    },
    true,
    () => tunableMs(f.store, "greenhouse.loopIntervalMs"),
    () => tunable(f.store, "greenhouse.burstSteps"),
  );
  try {
    t.mock.timers.tick(249);
    assert.equal(steps, 0);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(steps, 2);
    overrides(f, {
      "greenhouse.loopIntervalMs": 500,
      "greenhouse.burstSteps": 1,
    });
    t.mock.timers.tick(250);
    await setImmediate();
    assert.equal(steps, 3);
    t.mock.timers.tick(499);
    await setImmediate();
    assert.equal(steps, 3);
    t.mock.timers.tick(1);
    await setImmediate();
    assert.equal(steps, 4);
  } finally {
    await loop.close();
    await f.close();
  }
});

test("bridge failure stop count and cooldown values change on a running pull", async () => {
  const f = fixture({
    page: async () => {
      throw new GreenhouseBridgeTransient("Disconnected");
    },
  });
  try {
    const run = f.manager.start();
    overrides(f, {
      "greenhouse.bridgeFailuresBeforeStop": 3,
      "greenhouse.baseCooldownS": 30,
      "greenhouse.cooldownMultiplierCap": 1,
    });
    for (let failure = 1; failure <= 3; failure++) {
      await f.manager.tick();
      const saved = f.manager.ledger(run.id).run;
      assert.equal(saved.bridgeFailureCount, failure);
      assert.equal(saved.status, failure === 3 ? "failed" : "cooldown");
      if (failure < 3) {
        assert.equal(
          Date.parse(saved.retryAt!) - (at + (failure - 1) * 30000),
          30000,
        );
        f.setTime(Date.parse(saved.retryAt!));
      }
    }
  } finally {
    await f.close();
  }
});

test("review capacity retries use live initial and maximum cooldowns", async () => {
  const f = fixture();
  f.review.createResearch = async () => {
    throw Error("Model at capacity");
  };
  try {
    const run = f.manager.start(1);
    overrides(f, {
      "greenhouse.reviewCooldownInitialS": 10,
      "greenhouse.reviewCooldownMaxMin": 1,
    });
    let clock = at;
    for (const [index, delay] of [
      10000, 20000, 40000, 60000, 60000,
    ].entries()) {
      await advanceUntil(
        f,
        () =>
          (f.manager.ledger(run.id).run.reviewCooldown?.failures ?? 0) > index,
      );
      const cooldown = f.manager.ledger(run.id).run.reviewCooldown!;
      assert.equal(Date.parse(cooldown.retryAt) - clock, delay);
      clock = Date.parse(cooldown.retryAt);
      f.setTime(clock);
    }
  } finally {
    await f.close();
  }
});

test("adaptive pacing reads step and clean-page recovery overrides at use time", async () => {
  const f = fixture();
  try {
    const run = f.manager.ledger(f.manager.start().id).run;
    overrides(f, {
      "greenhouse.pacingStepMs": 500,
      "greenhouse.pacingRecoveryPages": 2,
    });
    const increased = {
      ...run,
      ...recordGreenhousePacingIncrease(f.store, run, "HTTP 429", at),
    };
    assert.equal(increased.pacingRate, 2500);
    const clean = recordGreenhousePacingRecovery(f.store, increased, at);
    assert.equal(clean.pacingRate, 2500);
    assert.equal(clean.pacingCleanPages, 1);
    overrides(f, { "greenhouse.pacingStepMs": 250 });
    const recovered = recordGreenhousePacingRecovery(f.store, clean, at);
    assert.equal(recovered.pacingRate, 2250);
    assert.equal(recovered.pacingCleanPages, 0);
    assert.match(recovered.activity!.at(-1)!.text, /after 2 clean pages$/);
  } finally {
    await f.close();
  }
});

test("activity retention can exceed the old cap and lane projection responds immediately", async () => {
  const f = fixture();
  try {
    const run = f.manager.ledger(f.manager.start().id).run;
    const activity = Array.from({ length: 230 }, (_, index) => ({
      lane: index % 2 ? ("search" as const) : ("review" as const),
      level: "info" as const,
      text: `Event ${index}`,
      at: new Date(at).toISOString(),
    }));
    f.store.put("greenhouse_pull_run", run.id, { ...run, activity });
    overrides(f, {
      "greenhouse.activityPerRun": 250,
      "greenhouse.activityPerLane": 5,
    });
    f.manager.action(run.id, "pause");
    assert.equal(f.manager.ledger(run.id).run.activity.length, 231);
    assert.equal(f.manager.state()!.activity!.length, 10);
    overrides(f, {
      "greenhouse.activityPerRun": 50,
      "greenhouse.activityPerLane": 10,
    });
    f.manager.action(run.id, "resume");
    assert.equal(f.manager.ledger(run.id).run.activity.length, 50);
    assert.equal(f.manager.state()!.activity!.length, 20);
  } finally {
    await f.close();
  }
});

test("a candidate outcome never persists more activity than the retention cap", async () => {
  const f = fixture();
  try {
    const run = f.manager.ledger(f.manager.start().id).run;
    const activity = Array.from({ length: 120 }, (_, index) => ({
      lane: "review" as const,
      level: "info" as const,
      text: `Event ${index}`,
      at: new Date(at).toISOString(),
    }));
    f.store.put("greenhouse_pull_run", run.id, { ...run, activity });
    overrides(f, { "greenhouse.activityPerRun": 50 });
    const candidate = {
      id: `${run.id}:example:1`,
      runId: run.id,
      state: "discovered" as const,
      card: card("1"),
    };
    // disposition() is the single write path for a decided candidate.
    (
      f.manager as unknown as {
        disposition: (
          r: unknown,
          c: unknown,
          s: string,
          reason: string,
        ) => void;
      }
    ).disposition(
      f.store.get("greenhouse_pull_run", run.id),
      candidate,
      "excluded",
      "Not a fit",
    );
    assert.equal(f.manager.ledger(run.id).run.activity.length, 50);
  } finally {
    await f.close();
  }
});

test("card date margin is captured with the policy for the next pull", async () => {
  const f = fixture();
  try {
    overrides(f, { "greenhouse.cardDateMarginDays": 3 });
    const run = f.manager.ledger(f.manager.start().id).run;
    overrides(f, { "greenhouse.cardDateMarginDays": 0 });
    const candidate = {
      id: `${run.id}:example:1`,
      runId: run.id,
      state: "discovered" as const,
      card: {
        ...card("1"),
        firstPublished: new Date(at - 9 * 86400000).toISOString(),
      },
    };
    assert.equal(run.policy?.cardDateMarginDays, 3);
    assert.equal(
      greenhouseCardDisposition(f.store, candidate, [], at),
      undefined,
    );
    f.manager.action(run.id, "stop", true);
    const next = f.manager.ledger(f.manager.start().id).run;
    assert.match(
      greenhouseCardDisposition(
        f.store,
        { ...candidate, runId: next.id },
        [],
        at,
      )!.reason,
      /Older than 7 days/,
    );
  } finally {
    await f.close();
  }
});

test("availability reads the live pause before every uncached request", async () => {
  const f = fixture();
  let manager: OpeningValidationManager | undefined;
  try {
    for (const id of ["one", "two"])
      f.store.put(
        "custom_opening",
        id,
        legacyOpening({ id, url: `https://example.com/jobs/${id}` }),
      );
    overrides(f, { "validation.pauseMs": 100 });
    const calls: number[] = [];
    manager = new OpeningValidationManager(
      f.store,
      () => {},
      async (url) => {
        calls.push(performance.now());
        overrides(f, { "validation.pauseMs": 300 });
        return {
          requestedUrl: url,
          url,
          status: 200,
          type: "text/html",
          text: "<h1>This job is closed</h1>",
          at: new Date(at).toISOString(),
        };
      },
    );
    const started = performance.now();
    manager.start();
    const deadline = performance.now() + 5000;
    while (
      manager.state()?.status === "running" &&
      performance.now() < deadline
    )
      await delay(10);
    assert.equal(manager.state()?.status, "completed");
    assert.equal(calls.length, 2);
    assert.ok(calls[0] - started >= 90);
    assert.ok(calls[1] - calls[0] >= 290);
  } finally {
    await manager?.close();
    await f.close();
  }
});

test("availability closure length and saved notice read configured thresholds", () => {
  const opening = {
    url: "https://example.com/job",
    title: "Engineer",
    job_id: "1",
  };
  const text = `${"Details ".repeat(220)}This job is closed`;
  const page = {
    requestedUrl: opening.url,
    url: opening.url,
    status: 200,
    type: "text/html",
    text: `<main>${text}</main>`,
    at: new Date(at).toISOString(),
  };
  assert.equal(inspectPosting(page, opening).status, "unknown");
  const verdict = inspectPosting(page, opening, false, {
    tunables: {
      "validation.shortPageChars": 2000,
      "validation.noticeChars": 100,
    },
  });
  assert.equal(verdict.status, "closed");
  assert.equal(verdict.reason.length, "Employer notice: ".length + 100);
});
