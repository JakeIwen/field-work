import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { ApplicationPreparationManager } from "../server/application-preparation.js";
import { GreenhousePullManager } from "../server/greenhouse-pull.js";
import { GmailManager } from "../server/gmail/manager.js";
import { Store } from "../server/storage.js";
import {
  tunable,
  tunableMs,
  tunableMsOr,
  tunableOr,
  type TimeTunableKey,
} from "../server/tunables.js";
import {
  tunables,
  tunableGroups,
  tunableProblem,
  tunableValue,
  tunablesProblem,
  tunablesPath,
  tunablesConflict,
  type TunableKey,
} from "../shared/tunables.js";

const keys = Object.keys(tunables) as TunableKey[];

test("tunable registry has valid, unique keys, defaults, groups and complete help", () => {
  const groups = new Set(tunableGroups.map((group) => group.id));
  assert.equal(groups.size, tunableGroups.length);
  assert.equal(new Set(keys.map((key) => tunables[key].key)).size, keys.length);
  for (const key of keys) {
    const entry = tunables[key];
    assert.equal(entry.key, key);
    assert.ok(groups.has(entry.group), key);
    assert.equal(tunableProblem(key, entry.default), null, key);
    assert.ok(entry.default >= entry.min && entry.default <= entry.max, key);
    assert.ok(entry.help.trim().length > 0 && entry.help.endsWith("."), key);
    assert.equal(tunableProblem(key, entry.min), null, key);
    assert.equal(tunableProblem(key, entry.max), null, key);
    for (const invalid of [
      NaN,
      Infinity,
      -Infinity,
      "1",
      true,
      {},
      [],
      entry.min - 1,
      entry.max + 1,
      entry.default + 0.5,
    ])
      assert.ok(tunableProblem(key, invalid), `${key}: ${String(invalid)}`);
  }
  assert.equal(tunablesProblem({}), null);
  assert.equal(tunableValue({}, "gmail.pageSize"), 50);
});

test("registry labels read as phrases and rows share no repeated boilerplate", () => {
  assert.equal(
    Object.hasOwn(tunables, "documents.remoteRenderConcurrency"),
    false,
  );
  const labels = new Set<string>();
  for (const key of keys) {
    const { label, help } = tunables[key];
    assert.ok(!labels.has(label), `duplicate label ${label}`);
    labels.add(label);
    assert.ok(
      /^[A-Z][a-z]/.test(label) && !/ [A-Z][a-z]+ [A-Z]/.test(label),
      `${key}: ${label}`,
    );
    assert.ok(!/Changes take effect at the next use/.test(help), key);
  }
});

test("row bounds and help state what a setting can and cannot do", () => {
  assert.equal(tunables["server.brotliQuality"].max, 9);
  assert.equal(tunables["server.gzipLevel"].min, 1);
  assert.equal(tunables["careers.workers"].max, 6);
  assert.equal(tunables["careers.responseLimitMiB"].max, 32);
  assert.equal(tunables["documents.retainedVersions"].min, 2);
  assert.equal(tunables["documents.renderTimeoutS"].max, 60);
  assert.equal(tunables["autofill.attachmentLimitMiB"].max, 8);
  assert.match(
    tunables["autofill.attachmentLimitMiB"].help,
    /8 MiB.*only be lowered/,
  );
  assert.match(
    tunables["documents.renderTimeoutS"].help,
    /60 s limit.*cloud-side/,
  );
  for (const key of [
    "documents.retainedVersions",
    "models.taskEventCap",
    "models.claudeThreadTurns",
    "greenhouse.guidanceHistoryEntries",
    "greenhouse.activityPerRun",
  ] as const)
    assert.match(
      tunables[key].help,
      /Lowering this deletes the older items on the next write; that cannot be undone\./,
      key,
    );
  assert.match(
    tunables["greenhouse.cardDateMarginDays"].help,
    /next pull; running pulls keep the margin they captured/,
  );
  assert.match(
    tunables["server.sourcePollMs"].help,
    /company_careers.*source_data.*rescan/,
  );
  assert.match(
    tunables["gmail.requestTimeoutS"].help,
    /reads mail may take; sending and sign-in/,
  );
  assert.match(
    tunables["records.activityPageSize"].help,
    /^Entries loaded per page of activity\./,
  );
});

const invalidPatches: { values: unknown; match: RegExp }[] = [
  {
    values: { "unknown.value": 1 },
    match: /Unknown tunable "unknown.value"/,
  },
  { values: { toString: null }, match: /Unknown tunable/ },
  {
    values: { "gmail.pageSize": 101 },
    match: /"Messages per Gmail page".*10 to 100/,
  },
  { values: { "gmail.pageSize": "50" }, match: /whole number/ },
  { values: { "gmail.pageSize": 5.5 }, match: /whole number/ },
  { values: { "gmail.pageSize": true }, match: /whole number/ },
  { values: { "gmail.pageSize": {} }, match: /whole number/ },
  { values: { "gmail.pageSize": [] }, match: /whole number/ },
  { values: [], match: /must be an object/ },
  { values: null, match: /must be an object/ },
  { values: undefined, match: /must be an object/ },
  {
    values: {
      "gmail.pageSize": 25,
      "greenhouse.reviewCooldownMaxMin": 1,
      "greenhouse.reviewCooldownInitialS": 120,
    },
    match: /Longest review retry delay.*First review retry delay/,
  },
  {
    values: {
      "greenhouse.activityPerRun": 50,
      "greenhouse.activityPerLane": 100,
    },
    match: /Activity shown per lane.*Activity kept per pull run/,
  },
  {
    values: { "browser.reloadPollMs": 10000, "browser.reloadPollCapS": 5 },
    match: /Longest reload status poll delay.*Reload status poll/,
  },
  {
    values: { "records.exportQuietS": 10, "records.exportDebounceCapS": 5 },
    match: /Longest export delay during steady writes.*Export quiet period/,
  },
  {
    values: {
      "careers.pageLoadWaitS": 30,
      "careers.networkSettleS": 20,
      "careers.captureDelayMs": 10000,
      "careers.browserRequestTimeoutS": 60,
    },
    match:
      /Wait for a careers page to load.*Pause before capturing a page.*Browser request timeout/,
  },
  {
    values: {
      "autofill.fetchRetryDelayMs": 30000,
      "autofill.fetchMaxWaitS": 10,
    },
    match: /Form read retry delay.*Longest wait for a retry/,
  },
  {
    values: { "gmail.lookbackDays": 1, "gmail.overlapDays": 2 },
    match: /Scan overlap.*First-scan lookback/,
  },
  {
    values: {
      "documents.renderTimeoutS": 60,
      "documents.remoteRenderDeadlineAllowanceS": 30,
      "documents.remoteRenderDeadlineCeilingS": 60,
    },
    match:
      /Remote render deadline ceiling.*Cloud render timeout.*Remote render extra allowance/,
  },
];

test("tunables reject invalid patches and stale versions without writes or wakeups", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tunables-settings-"));
  const workspace = await openFixtureWorkspace(root);
  const preparationWake = t.mock.method(
    ApplicationPreparationManager.prototype,
    "wake",
    () => {},
  );
  const greenhouseWake = t.mock.method(
    GreenhousePullManager.prototype,
    "wake",
    () => {},
  );
  const gmailReschedule = t.mock.method(
    GmailManager.prototype,
    "rescheduleBackground",
    () => {},
  );
  const exportReschedule = t.mock.method(
    Store.prototype,
    "rescheduleExport",
    () => {},
  );
  try {
    const old = workspace.store.settings();
    for (const { values, match } of invalidPatches) {
      const response = await workspace.post(tunablesPath, {
        expectedRevision: 0,
        values,
      });
      assert.equal(response.status, 400, JSON.stringify(values));
      assert.match((await response.json()).error, match);
      assert.deepEqual(workspace.store.settings(), old);
    }
    for (const expectedRevision of [undefined, "1", -1, 1.5])
      assert.equal(
        (await workspace.post(tunablesPath, { expectedRevision, values: {} }))
          .status,
        400,
      );
    const conflict = await workspace.post(tunablesPath, {
      expectedRevision: 1,
      values: { "gmail.pageSize": 30 },
    });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error, new RegExp(tunablesConflict));
    assert.deepEqual(workspace.store.settings(), old);
    assert.equal(preparationWake.mock.callCount(), 0);
    assert.equal(greenhouseWake.mock.callCount(), 0);
    assert.equal(gmailReschedule.mock.callCount(), 0);
    assert.equal(exportReschedule.mock.callCount(), 0);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tunables save, reset, preserve defaults and unrelated overrides, wake and persist", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tunables-settings-"));
  let workspace = await openFixtureWorkspace(root);
  const preparationWake = t.mock.method(
    ApplicationPreparationManager.prototype,
    "wake",
    () => {},
  );
  const greenhouseWake = t.mock.method(
    GreenhousePullManager.prototype,
    "wake",
    () => {},
  );
  const gmailReschedule = t.mock.method(
    GmailManager.prototype,
    "rescheduleBackground",
    () => {},
  );
  const exportReschedule = t.mock.method(
    Store.prototype,
    "rescheduleExport",
    () => {},
  );
  try {
    const old = workspace.store.settings();
    const values = {
      "gmail.pageSize": 40,
      "records.catalogPageSize": 50,
      "greenhouse.reviewCooldownMaxMin": 1,
      "greenhouse.reviewCooldownInitialS": 30,
    };
    const response = await workspace.post(tunablesPath, {
      expectedRevision: 0,
      values,
    });
    assert.equal(response.status, 200);
    // The revision moves, settings.version stays: pull forms use it for conflicts.
    assert.deepEqual(await response.json(), {
      ...old,
      tunables: values,
      tunablesRevision: 1,
    });
    assert.equal(tunable(workspace.store, "gmail.pageSize"), 40);
    // Validate against the merged saved settings: resetting the initial delay to
    // its default is valid here, but raising it beyond the saved cap is not.
    const bad = await workspace.post(tunablesPath, {
      expectedRevision: 1,
      values: { "greenhouse.reviewCooldownInitialS": 120 },
    });
    assert.equal(bad.status, 400);
    const reset = await workspace.post(tunablesPath, {
      expectedRevision: 1,
      values: {
        "gmail.pageSize": null,
        "greenhouse.reviewCooldownInitialS": null,
      },
    });
    assert.equal(reset.status, 200);
    const saved = workspace.store.settings();
    assert.deepEqual(saved.tunables, {
      "records.catalogPageSize": 50,
      "greenhouse.reviewCooldownMaxMin": 1,
    });
    assert.equal(saved.version, old.version);
    assert.equal(saved.tunablesRevision, 2);
    assert.equal(tunable(workspace.store, "gmail.pageSize"), 50);
    assert.equal(preparationWake.mock.callCount(), 2);
    assert.equal(greenhouseWake.mock.callCount(), 2);
    // Timers armed with the old values are recomputed from the new ones.
    assert.equal(gmailReschedule.mock.callCount(), 2);
    assert.equal(exportReschedule.mock.callCount(), 2);
    assert.deepEqual(
      workspace.store.personalExport().records.settings[0],
      saved,
    );
    await workspace.close();
    workspace = await openFixtureWorkspace(root);
    assert.deepEqual(workspace.store.settings(), saved);
    assert.deepEqual(
      (await (await workspace.get("/api/state")).json()).settings,
      saved,
    );
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a settings.version bump elsewhere does not conflict a tunables save", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tunables-revision-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    // Greenhouse pacing bumps settings.version during a pull.
    const old = workspace.store.settings();
    workspace.store.put("settings", "main", {
      ...old,
      version: old.version + 5,
    });
    const response = await workspace.post(tunablesPath, {
      expectedRevision: 0,
      values: { "gmail.pageSize": 30 },
    });
    assert.equal(response.status, 200);
    assert.equal(workspace.store.settings().version, old.version + 5);
    assert.equal(workspace.store.settings().tunablesRevision, 1);
    const stale = await workspace.post(tunablesPath, {
      expectedRevision: 0,
      values: { "gmail.pageSize": 31 },
    });
    assert.equal(stale.status, 409);
    assert.equal(tunable(workspace.store, "gmail.pageSize"), 30);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("saved overrides are parsed once per settings write, not once per lookup", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tunables-cache-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    const { db } = workspace.store;
    const prepare = t.mock.method(db, "prepare");
    const settingsReads = () =>
      prepare.mock.calls.filter((call) =>
        String(call.arguments[0]).includes("kind='settings'"),
      ).length;
    tunable(workspace.store, "gmail.pageSize");
    const first = settingsReads();
    for (let i = 0; i < 50; i++) tunable(workspace.store, "gmail.pageSize");
    assert.equal(settingsReads(), first);
    workspace.store.put("settings", "main", {
      ...workspace.store.settings(),
      tunables: { "gmail.pageSize": 60 },
    });
    // A saved change is visible on the very next call.
    assert.equal(tunable(workspace.store, "gmail.pageSize"), 60);
    assert.ok(settingsReads() > first);
    assert.throws(
      () =>
        workspace.store.transaction(() => {
          workspace.store.put("settings", "main", {
            ...workspace.store.settings(),
            tunables: { "gmail.pageSize": 70 },
          });
          assert.equal(tunable(workspace.store, "gmail.pageSize"), 70);
          throw new Error("roll back");
        }),
      /roll back/,
    );
    // A rolled-back write must not leave its value cached.
    assert.equal(tunable(workspace.store, "gmail.pageSize"), 60);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("tunableOr and tunableMsOr fall back to the registry default with no store", () => {
  assert.equal(tunableOr(undefined, "autofill.fetchAttempts"), 3);
  assert.equal(tunableMsOr(undefined, "gmail.requestTimeoutS"), 20_000);
  assert.equal(tunableMsOr(undefined, "autofill.fetchRetryDelayMs"), 1000);
  assert.equal(tunableMsOr(undefined, "records.exportRetryCapMin"), 300_000);
  assert.equal(tunableMsOr(undefined, "gmail.lookbackDays"), 90 * 86_400_000);
});

test("server tunables read live, fall back on corrupt values and convert every time unit", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "tunables-read-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    assert.equal(tunable(workspace.store, "gmail.pageSize"), 50);
    workspace.store.put("settings", "main", {
      ...workspace.store.settings(),
      tunables: { "gmail.pageSize": 101 },
    });
    assert.equal(tunable(workspace.store, "gmail.pageSize"), 50);
    workspace.store.put("settings", "main", {
      ...workspace.store.settings(),
      tunables: {
        "gmail.pageSize": 75,
        "autofill.fetchRetryDelayMs": 500,
        "gmail.requestTimeoutS": 20,
        "gmail.checkIntervalMin": 2,
        "gmail.lookbackDays": 3,
      },
    });
    assert.equal(tunable(workspace.store, "gmail.pageSize"), 75);
    for (const [key, expected] of [
      ["autofill.fetchRetryDelayMs", 500],
      ["gmail.requestTimeoutS", 20000],
      ["gmail.checkIntervalMin", 120000],
      ["gmail.lookbackDays", 259200000],
    ] as const)
      assert.equal(tunableMs(workspace.store, key), expected);
    for (const key of [
      "gmail.pageSize",
      "gmail.textLimitChars",
      "autofill.attachmentLimitMiB",
    ])
      assert.throws(
        () => tunableMs(workspace.store, key as TimeTunableKey),
        TypeError,
      );
    for (const invalid of [NaN, Infinity, 50.5])
      assert.equal(
        tunableValue(
          { tunables: { "gmail.pageSize": invalid } },
          "gmail.pageSize",
        ),
        50,
      );
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

const { render, createElement, fireEvent, waitFor, mutationRecorder } =
  await import("../client/testing/test-render.js");
const { default: Tunables } = await import("../client/settings/Tunables.js");
const { state: clientState } =
  await import("../client/testing/component-fixtures.js");

const pageSizeLabel = "Messages per Gmail page";

test("Timing and limits stays collapsed, filters rows, validates and saves only local edits", async () => {
  const { calls, mutate } = mutationRecorder();
  const notices: unknown[] = [];
  const state = {
    ...clientState,
    settings: { ...clientState.settings, tunablesRevision: 7 },
  };
  const props = {
    state,
    mutate,
    notify: (message: unknown) => {
      notices.push(message);
    },
  };
  const view = render(createElement(Tunables, props));
  assert.equal(view.queryByRole("spinbutton"), null);
  fireEvent.click(view.getByRole("button", { name: "Timing & limits" }));
  assert.equal(view.getAllByRole("spinbutton").length, keys.length);
  const search = view.getByRole("textbox", {
    name: "Search timing and limits",
  });
  fireEvent.change(search, { target: { value: "gmail.pageSize" } });
  assert.equal(view.getAllByRole("spinbutton").length, 1);
  assert.equal(view.queryByText("count"), null, "counts show no unit suffix");
  const input = view.getByRole("spinbutton", { name: pageSizeLabel });
  fireEvent.change(input, { target: { value: "101" } });
  // Errors name the row as the page shows it, never the setting key.
  const alert = view.getByRole("alert").textContent ?? "";
  assert.match(alert, new RegExp(`"${pageSizeLabel}".*10 to 100`));
  assert.ok(!alert.includes("gmail.pageSize"));
  assert.equal(
    (view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.change(input, { target: { value: "40" } });
  assert.equal(calls.length, 0);
  // A newer settings.version alone (a pull bumping pacing) leaves the draft valid.
  view.rerender(
    createElement(Tunables, {
      ...props,
      state: { ...state, settings: { ...state.settings, version: 99 } },
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(notices.length, 1));
  assert.deepEqual(calls, [
    {
      path: tunablesPath,
      body: { expectedRevision: 7, values: { "gmail.pageSize": 40 } },
      method: undefined,
    },
  ]);
});

test("Timing and limits resets overrides with null and discards drafts using current values", async () => {
  const { calls, mutate } = mutationRecorder();
  const state = {
    ...clientState,
    settings: {
      ...clientState.settings,
      tunablesRevision: 7,
      tunables: { "gmail.pageSize": 40 },
    },
  };
  const props = { state, mutate, notify: () => {} };
  const view = render(createElement(Tunables, props));
  fireEvent.click(view.getByRole("button", { name: "Timing & limits" }));
  fireEvent.change(
    view.getByRole("textbox", { name: "Search timing and limits" }),
    { target: { value: "gmail.pageSize" } },
  );
  fireEvent.click(view.getByRole("button", { name: "Default" }));
  assert.equal((view.getByRole("spinbutton") as HTMLInputElement).value, "50");
  assert.equal(view.queryByRole("button", { name: "Default" }), null);
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(calls.length, 1));
  assert.deepEqual(calls[0].body, {
    expectedRevision: 7,
    values: { "gmail.pageSize": null },
  });
  await waitFor(() =>
    assert.equal(
      view.queryByRole("button", { name: "Use current values" }),
      null,
    ),
  );
  fireEvent.change(view.getByRole("spinbutton"), { target: { value: "60" } });
  view.rerender(
    createElement(Tunables, {
      ...props,
      state: {
        ...state,
        settings: {
          ...state.settings,
          tunablesRevision: 8,
          tunables: { "gmail.pageSize": 50 },
        },
      },
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Use current values" }));
  assert.equal((view.getByRole("spinbutton") as HTMLInputElement).value, "50");
  assert.equal(calls.length, 1);
});

test("the changed marker shows only for an override that differs from the default", () => {
  const settings = {
    ...clientState.settings,
    tunables: { "gmail.pageSize": 50, "autofill.fetchAttempts": 5 },
  };
  const view = render(
    createElement(Tunables, {
      state: { ...clientState, settings },
      mutate: async () => {},
      notify: () => {},
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Timing & limits" }));
  assert.equal(view.getAllByText("changed").length, 1);
  fireEvent.change(
    view.getByRole("textbox", { name: "Search timing and limits" }),
    { target: { value: "autofill.fetchAttempts" } },
  );
  assert.equal(view.getAllByText("changed").length, 1);
  fireEvent.change(
    view.getByRole("textbox", { name: "Search timing and limits" }),
    { target: { value: "gmail.pageSize" } },
  );
  assert.equal(view.queryByText("changed"), null);
});

test("Timing and limits checks cross-field caps and keeps edits through a revision conflict", async () => {
  let reject = true;
  const calls: unknown[] = [];
  const state = {
    ...clientState,
    settings: { ...clientState.settings, tunablesRevision: 2 },
  };
  const props = {
    state,
    mutate: async (_path: string, body: unknown) => {
      calls.push(body);
      if (reject)
        throw new Error(`${tunablesConflict} Reload the values before saving.`);
      return {};
    },
    notify: () => {},
  };
  const view = render(createElement(Tunables, props));
  fireEvent.click(view.getByRole("button", { name: "Timing & limits" }));
  const search = view.getByRole("textbox", {
    name: "Search timing and limits",
  });
  fireEvent.change(search, { target: { value: "greenhouse.reviewCooldown" } });
  fireEvent.change(
    view.getByRole("spinbutton", { name: "First review retry delay" }),
    { target: { value: "120" } },
  );
  fireEvent.change(
    view.getByRole("spinbutton", { name: "Longest review retry delay" }),
    { target: { value: "1" } },
  );
  const cross = view.getByRole("alert").textContent ?? "";
  assert.match(cross, /Longest review retry delay.*First review retry delay/);
  assert.ok(!cross.includes("reviewCooldown"));
  assert.equal(
    (view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    true,
  );
  fireEvent.change(
    view.getByRole("spinbutton", { name: "Longest review retry delay" }),
    { target: { value: "3" } },
  );
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    assert.match(
      view.getByRole("alert").textContent ?? "",
      /Settings changed elsewhere; your edits are kept, save again\./,
    ),
  );
  const maxInput = () =>
    view.getByRole("spinbutton", {
      name: "Longest review retry delay",
    }) as HTMLInputElement;
  assert.equal(maxInput().value, "3");
  // Once the refreshed settings arrive, the same draft saves against them.
  reject = false;
  view.rerender(
    createElement(Tunables, {
      ...props,
      state: { ...state, settings: { ...state.settings, tunablesRevision: 3 } },
    }),
  );
  assert.equal(maxInput().value, "3");
  fireEvent.click(view.getByRole("button", { name: "Save" }));
  await waitFor(() => assert.equal(calls.length, 2));
  assert.equal((calls[0] as { expectedRevision: number }).expectedRevision, 2);
  assert.equal((calls[1] as { expectedRevision: number }).expectedRevision, 3);
});

test("Save explains an invalid value hidden by the search", () => {
  const view = render(
    createElement(Tunables, {
      state: clientState,
      mutate: async () => {},
      notify: () => {},
    }),
  );
  fireEvent.click(view.getByRole("button", { name: "Timing & limits" }));
  const search = view.getByRole("textbox", {
    name: "Search timing and limits",
  });
  fireEvent.change(search, { target: { value: "gmail.pageSize" } });
  fireEvent.change(view.getByRole("spinbutton", { name: pageSizeLabel }), {
    target: { value: "9999" },
  });
  fireEvent.change(search, { target: { value: "autofill.fetchAttempts" } });
  fireEvent.change(
    view.getByRole("spinbutton", { name: "Form read attempts" }),
    {
      target: { value: "4" },
    },
  );
  assert.match(
    view.getByText(/hidden by the search has an invalid value/).textContent ??
      "",
    new RegExp(
      `1 row hidden by the search has an invalid value: ${pageSizeLabel}\\.`,
    ),
  );
  assert.equal(
    (view.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled,
    true,
  );
});
