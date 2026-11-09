import test from "node:test";
import assert from "node:assert/strict";
import {
  READINESS_TIMEOUT_MS,
  serviceEnabled,
  startService,
  waitForHealthy,
  type HealthyService,
  type LaunchdJob,
  type ReadinessWait,
  type ServiceRuntime,
} from "../scripts/service-control.js";

function serviceFixture(
  loaded = true,
  enabled = true,
  pid: number | null = 101,
) {
  const state = { loaded, enabled, pid: loaded ? pid : null };
  const commands: string[] = [];
  const waits: (number | undefined)[] = [];
  const control = {
    inspect: () => ({ loaded: state.loaded, pid: state.pid, raw: "" }),
    enabled: () => state.enabled,
    enable: () => {
      commands.push("enable");
      state.enabled = true;
    },
    stopOwnedProcess: async () => {
      commands.push("stop");
      if (state.loaded && state.enabled) state.pid = 202;
      return true;
    },
    bootstrap: () => {
      commands.push("bootstrap");
      state.loaded = true;
      state.pid = 202;
    },
    kickstart: () => {
      commands.push("kickstart");
      state.pid = 202;
    },
    waitHealthy: async (previousPid?: number): Promise<HealthyService> => {
      waits.push(previousPid);
      assert.ok(state.loaded && state.enabled && state.pid);
      assert.notEqual(state.pid, previousPid);
      return { job: control.inspect(), live: { pid: state.pid } };
    },
  };
  return { control, state, commands, waits };
}

function readinessFixture(options: {
  job?: LaunchdJob;
  livePid?: number;
  runtime?: ServiceRuntime | null;
  readyAt?: number;
  startedAt?: number;
  healthDuration?: (
    call: number,
    timeoutMs: number,
    elapsedMs: number,
  ) => number;
}) {
  const job = options.job ?? { loaded: true, pid: 101, raw: "" };
  const livePid = options.livePid ?? job.pid ?? 0;
  const runtime =
    options.runtime === undefined
      ? job.pid
        ? { pid: job.pid, root: "/repo", serviceLabel: "com.example.service" }
        : null
      : options.runtime;
  const healthRequests: { at: number; timeoutMs: number }[] = [];
  const sleeps: { at: number; ms: number }[] = [];
  const progress: [number, number][] = [];
  const started = options.startedAt ?? 0;
  let now = started;
  let healthCall = 0;
  const control: ReadinessWait = {
    inspect: () => job,
    health: async (timeoutMs) => {
      healthRequests.push({ at: now - started, timeoutMs });
      now +=
        options.healthDuration?.(healthCall++, timeoutMs, now - started) ?? 0;
      return options.readyAt === undefined || now - started >= options.readyAt
        ? { pid: livePid }
        : null;
    },
    runtime: () => runtime,
    sleep: async (ms) => {
      sleeps.push({ at: now - started, ms });
      now += ms;
    },
    now: () => now,
    root: "/repo",
    serviceLabel: "com.example.service",
    onProgress: (elapsedMs, limitMs) => progress.push([elapsedMs, limitMs]),
    onTimeout: (timedOutJob) =>
      new Error(timedOutJob.loaded ? "loaded timeout" : "unloaded timeout"),
  };
  return {
    control,
    healthRequests,
    sleeps,
    progress,
    now: () => now - started,
  };
}

test("restart keeps the registration loaded and waits for a replacement PID", async () => {
  const fixture = serviceFixture();
  const result = await startService(fixture.control, true);
  assert.equal(result.live.pid, 202);
  assert.equal(fixture.state.loaded, true);
  assert.deepEqual(fixture.commands, ["stop"]);
  assert.deepEqual(fixture.waits, [undefined, 101]);
});

test("start and restart recover an installed but unloaded service", async () => {
  for (const restart of [false, true]) {
    const fixture = serviceFixture(false);
    const result = await startService(fixture.control, restart);
    assert.equal(result.live.pid, 202);
    assert.deepEqual(fixture.commands, ["stop", "bootstrap"]);
  }
});

test("a disabled service is enabled before it starts", async () => {
  const fixture = serviceFixture(false, false);
  await startService(fixture.control);
  assert.deepEqual(fixture.commands, ["enable", "stop", "bootstrap"]);
});

test("start leaves an already running service alone", async () => {
  const fixture = serviceFixture();
  const result = await startService(fixture.control);
  assert.equal(result.live.pid, 101);
  assert.deepEqual(fixture.commands, []);
});

test("start kickstarts a loaded job without a worker", async () => {
  const fixture = serviceFixture(true, true, null);
  await startService(fixture.control);
  assert.deepEqual(fixture.commands, ["kickstart"]);
});

test("restart preserves registration when graceful shutdown is refused", async () => {
  const fixture = serviceFixture();
  fixture.control.stopOwnedProcess = async () => {
    throw new Error("shutdown refused");
  };
  await assert.rejects(startService(fixture.control, true), /shutdown refused/);
  assert.equal(fixture.state.loaded, true);
  assert.equal(fixture.state.pid, 101);
  assert.deepEqual(fixture.commands, []);
});

test("restart reports failed recovery without unloading or starting another server", async () => {
  const fixture = serviceFixture();
  const waitHealthy = fixture.control.waitHealthy;
  fixture.control.waitHealthy = async (previousPid?: number) => {
    if (previousPid) throw new Error("replacement did not become healthy");
    return waitHealthy();
  };
  await assert.rejects(
    startService(fixture.control, true),
    /replacement did not become healthy/,
  );
  assert.equal(fixture.state.loaded, true);
  assert.deepEqual(fixture.commands, ["stop"]);
});

test("a foreign listener prevents bootstrapping a second server", async () => {
  const fixture = serviceFixture(false);
  fixture.control.stopOwnedProcess = async () => {
    throw new Error("unrecognized process");
  };
  await assert.rejects(startService(fixture.control), /unrecognized process/);
  assert.deepEqual(fixture.commands, []);
  assert.equal(fixture.state.loaded, false);
});

test("waits through a 30-second startup window for a 100-second import", async () => {
  const fixture = readinessFixture({
    readyAt: 100_000,
    startedAt: 23_456,
    healthDuration: (_call, timeoutMs) => Math.min(100, timeoutMs),
  });
  const result = await waitForHealthy(fixture.control);

  assert.equal(result.live.pid, 101);
  assert.ok(fixture.now() >= 100_000);
  assert.ok(fixture.now() < READINESS_TIMEOUT_MS);
  assert.equal(fixture.healthRequests[0]?.timeoutMs, 5_000);
  for (const request of fixture.healthRequests)
    assert.ok(
      request.timeoutMs <= READINESS_TIMEOUT_MS - request.at,
      `health timeout exceeded remaining budget at ${request.at}ms`,
    );
  for (const sleep of fixture.sleeps)
    assert.ok(
      sleep.ms <= READINESS_TIMEOUT_MS - sleep.at,
      `sleep exceeded remaining budget at ${sleep.at}ms`,
    );
});

test("accepts readiness just before the 180-second deadline, but not at it", async () => {
  const nearDeadline = readinessFixture({
    readyAt: READINESS_TIMEOUT_MS - 1,
    healthDuration: (_call, timeoutMs, elapsed) =>
      Math.min(timeoutMs, READINESS_TIMEOUT_MS - 1 - elapsed),
  });
  const result = await waitForHealthy(nearDeadline.control);
  assert.equal(result.live.pid, 101);

  const atDeadline = readinessFixture({
    readyAt: READINESS_TIMEOUT_MS,
    healthDuration: (_call, timeoutMs) => timeoutMs,
  });
  await assert.rejects(waitForHealthy(atDeadline.control), /loaded timeout/);
});

test("bounds slow probes and retry sleeps by the remaining deadline", async () => {
  const fixture = readinessFixture({
    readyAt: Number.POSITIVE_INFINITY,
    healthDuration: (_call, timeoutMs) => Math.min(60_000, timeoutMs),
  });
  await assert.rejects(waitForHealthy(fixture.control), /loaded timeout/);

  assert.equal(fixture.now(), READINESS_TIMEOUT_MS);
  for (const request of fixture.healthRequests)
    assert.ok(request.timeoutMs <= READINESS_TIMEOUT_MS - request.at);
  for (const sleep of fixture.sleeps)
    assert.ok(sleep.ms <= READINESS_TIMEOUT_MS - sleep.at);
});

test("includes launchd inspection time in the readiness budget", async () => {
  const fixture = readinessFixture({ readyAt: Number.POSITIVE_INFINITY });
  const budgets: number[] = [];
  const inspect = fixture.control.inspect;
  fixture.control.inspect = (timeoutMs) => {
    budgets.push(timeoutMs);
    // The fixture's sleep advances its fake monotonic clock synchronously.
    void fixture.control.sleep(Math.min(60_000, timeoutMs));
    return inspect(timeoutMs);
  };
  await assert.rejects(waitForHealthy(fixture.control), /loaded timeout/);
  assert.equal(fixture.now(), READINESS_TIMEOUT_MS);
  assert.deepEqual(budgets, [180_000, 119_750, 59_500]);
});

test("does not accept a mismatched HTTP PID", async () => {
  const fixture = readinessFixture({
    livePid: 202,
    healthDuration: (_call, timeoutMs, elapsed) =>
      Math.min(timeoutMs, READINESS_TIMEOUT_MS - 1 - elapsed),
  });
  await assert.rejects(waitForHealthy(fixture.control), /loaded timeout/);
});

test("requires matching runtime ownership and a loaded launchd PID", async () => {
  const runtimes: (ServiceRuntime | null)[] = [
    null,
    { pid: 202, root: "/repo", serviceLabel: "com.example.service" },
    { pid: 101, root: "/another-repo", serviceLabel: "com.example.service" },
    { pid: 101, root: "/repo", serviceLabel: "com.another.service" },
  ];
  for (const runtime of runtimes) {
    const fixture = readinessFixture({ runtime });
    await assert.rejects(waitForHealthy(fixture.control), /loaded timeout/);
  }
  const unloaded = readinessFixture({
    job: { loaded: false, pid: 101, raw: "" },
  });
  await assert.rejects(
    waitForHealthy(unloaded.control),
    /^Error: unloaded timeout$/,
  );
  const noWorker = readinessFixture({
    job: { loaded: true, pid: null, raw: "" },
  });
  await assert.rejects(
    waitForHealthy(noWorker.control),
    /^Error: loaded timeout$/,
  );
});

test("waits for an old PID to be replaced", async () => {
  let now = 0;
  let pid = 101;
  const control: ReadinessWait = {
    inspect: () => ({ loaded: true, pid, raw: "" }),
    health: async (timeoutMs) => {
      now += Math.min(5_000, timeoutMs);
      if (now >= 100_000) pid = 202;
      return { pid };
    },
    runtime: () => ({
      pid,
      root: "/repo",
      serviceLabel: "com.example.service",
    }),
    sleep: async (ms) => {
      now += ms;
    },
    now: () => now,
    root: "/repo",
    serviceLabel: "com.example.service",
    onTimeout: (job) =>
      new Error(job.loaded ? "loaded timeout" : "unloaded timeout"),
  };

  const result = await waitForHealthy(control, 101);
  assert.equal(result.live.pid, 202);
  assert.ok(now >= 100_000);
});

test("reports progress immediately and about every ten seconds", async () => {
  const fixture = readinessFixture({
    readyAt: 30_000,
    startedAt: 23_456,
  });
  await waitForHealthy(fixture.control);

  assert.deepEqual(fixture.progress.slice(0, 4), [
    [0, READINESS_TIMEOUT_MS],
    [10_000, READINESS_TIMEOUT_MS],
    [20_000, READINESS_TIMEOUT_MS],
    [30_000, READINESS_TIMEOUT_MS],
  ]);
  assert.ok(fixture.progress.every((entry) => entry.length === 2));
});

test("launchd enabled overrides support both text and boolean output", () => {
  for (const [value, expected] of [
    ["enabled", true],
    ["disabled", false],
    ["false", true],
    ["true", false],
  ] as const) {
    assert.equal(
      serviceEnabled(
        `\tdisabled services = {\n\t\t"local.fieldwork" => ${value}\n\t}`,
        "local.fieldwork",
      ),
      expected,
    );
  }
  assert.equal(
    serviceEnabled('\t"local.other" => disabled', "local.fieldwork"),
    true,
  );
  assert.throws(
    () => serviceEnabled('"local.fieldwork" => unknown', "local.fieldwork"),
    /Cannot determine/,
  );
});
