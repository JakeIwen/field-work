import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Store } from "../server/storage.js";
import { sampleWorkspaceRoot as repositoryRoot } from "./fixtures/sample-workspace.js";
import { Scheduler, withNextRuns } from "../server/scheduler.js";
import { createWorkspace } from "../server/server.js";
import { listenOnEphemeralPort } from "./fixtures/ephemeral-port.js";
import { defaultSchedules } from "../shared/schedules.js";
import { defaultFitCriteria } from "../shared/fit-criteria.js";

const hour = 3_600_000;
test("scheduler starts due runs only when idle, records lastStartedAt/nextRunAt and journals failures", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "scheduler-"));
  const store = new Store(repositoryRoot, dir);
  try {
    let t = Date.parse("2026-09-28T12:00:00Z"),
      idle = true,
      failScan: Error | null = null;
    const scans: string[] = [],
      validations: number[] = [];
    let prepared = 0;
    const scheduler = new Scheduler({
      store,
      clock: () => t,
      isIdle: () => idle,
      notify: () => {},
      scans: {
        start: (_mode, requestId) => {
          if (failScan) throw failScan;
          scans.push(requestId);
        },
      },
      validation: { start: () => validations.push(t) },
      prepareScan: async () => {
        prepared++;
      },
    });
    const settings = store.get("settings", "main");
    store.put("settings", "main", {
      ...settings,
      schedules: {
        ...defaultSchedules,
        careersScan: { ...defaultSchedules.careersScan, enabled: true },
      },
    });
    assert.equal(
      await scheduler.tick(),
      null,
      "no runs during the startup delay",
    );
    t += 2 * 60_000;
    idle = false;
    assert.equal(await scheduler.tick(), null, "busy workspace defers");
    idle = true;
    assert.equal(await scheduler.tick(), "careersScan");
    assert.equal(prepared, 1);
    assert.deepEqual(scans, ["schedule-2026-09-28T12:02:00.000Z"]);
    let saved = store.settings().schedules;
    assert.equal(saved.careersScan.lastStartedAt, "2026-09-28T12:02:00.000Z");
    assert.equal(saved.careersScan.nextRunAt, "2026-09-29T12:02:00.000Z");
    assert.equal(saved.openingValidation.nextRunAt, null);
    assert.equal(await scheduler.tick(), null, "not due again yet");
    store.put("settings", "main", {
      ...store.get("settings", "main"),
      schedules: {
        ...saved,
        openingValidation: {
          ...saved.openingValidation,
          enabled: true,
          intervalHours: 6,
        },
      },
    });
    assert.equal(await scheduler.tick(), "openingValidation");
    assert.equal(validations.length, 1);
    t += 24 * hour;
    failScan = new Error("No monitored companies");
    assert.equal(
      await scheduler.tick(),
      "openingValidation",
      "a failed scan start is journaled and the next due schedule still runs",
    );
    assert.ok(
      store
        .list("journal")
        .some(
          (e) =>
            e.type === "schedule_error" &&
            /No monitored companies/.test(e.message),
        ),
    );
    assert.equal(
      store.settings().schedules.careersScan.lastStartedAt,
      "2026-09-28T12:02:00.000Z",
      "a failed start is not recorded as a run",
    );
    failScan = null;
    t += 30 * 60_000;
    assert.equal(
      await scheduler.tick(),
      null,
      "failed schedules back off before retrying",
    );
    t += hour;
    assert.equal(await scheduler.tick(), "careersScan");
    assert.equal(scans.length, 2);
    assert.ok(
      store.list("journal").filter((e) => e.type === "schedule_started")
        .length >= 3,
    );
    scheduler.start();
    scheduler.stop();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("nextRunAt derives from the last start, or now for enabled schedules that never ran", () => {
  const at = Date.parse("2026-09-28T00:00:00Z");
  const s = withNextRuns(
    {
      careersScan: { enabled: true, intervalHours: 12, lastStartedAt: null },
      openingValidation: {
        enabled: true,
        intervalHours: 2,
        lastStartedAt: "2026-09-27T23:00:00.000Z",
      },
    },
    at,
  );
  assert.equal(s.careersScan.nextRunAt, "2026-09-28T00:00:00.000Z");
  assert.equal(s.openingValidation.nextRunAt, "2026-09-28T01:00:00.000Z");
  assert.equal(withNextRuns({}, at).careersScan.nextRunAt, null);
});

test("settings API validates schedules and fit criteria, fills defaults and never forges run times", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "settings-api-"));
  const { server, port } = await listenOnEphemeralPort();
  const workspace = await createWorkspace({
    root: repositoryRoot,
    dataDir: dir,
    port,
    connectAgent: false,
    watch: false,
  });
  server.on("request", workspace.app);
  const base = `http://127.0.0.1:${port}`;
  const csrf = (await (await fetch(base + "/api/session")).json()).csrfToken;
  const post = (url: string, body: any) =>
    fetch(base + url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify(body),
    });
  try {
    let state = await (await fetch(base + "/api/state")).json();
    assert.deepEqual(state.settings.fitCriteria, defaultFitCriteria);
    assert.equal(state.settings.schedules.careersScan.enabled, false);
    const version = state.settings.version;
    assert.equal((await post("/api/settings", {})).status, 400);
    assert.equal(
      (await post("/api/settings", { timezone: "Not/AZone" })).status,
      400,
    );
    assert.equal((await post("/api/settings", { schedules: [] })).status, 400);
    let response = await post("/api/settings", {
      schedules: {
        careersScan: {
          enabled: true,
          intervalHours: 500,
          lastStartedAt: "2000-01-01T00:00:00Z",
        },
      },
    });
    assert.equal(response.status, 200);
    let settings = await response.json();
    assert.equal(settings.version, version + 1);
    assert.equal(settings.timezone, state.settings.timezone);
    assert.equal(settings.schedules.careersScan.intervalHours, 168);
    assert.equal(settings.schedules.careersScan.lastStartedAt, null);
    assert.ok(
      Math.abs(
        Date.parse(settings.schedules.careersScan.nextRunAt) - Date.now(),
      ) < 60_000,
    );
    assert.equal(settings.schedules.openingValidation.enabled, false);
    response = await post("/api/settings", {
      fitCriteria: {
        ...defaultFitCriteria,
        seniorityTerms: ["senior", "staff", "", "x".repeat(61)],
      },
      timezone: "America/Denver",
    });
    settings = await response.json();
    assert.deepEqual(settings.fitCriteria.seniorityTerms, ["senior", "staff"]);
    assert.equal(settings.fitCriteria.version, 2);
    assert.equal(settings.timezone, "America/Denver");
    assert.equal(
      settings.schedules.careersScan.enabled,
      true,
      "saving criteria keeps schedules",
    );
    state = await (await fetch(base + "/api/state")).json();
    assert.deepEqual(state.settings.fitCriteria.seniorityTerms, [
      "senior",
      "staff",
    ]);
  } finally {
    server.closeAllConnections();
    server.close();
    await workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
