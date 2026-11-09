import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";
import { ApplicationPreparationManager } from "../server/application-preparation.js";
import { parallelPreparations } from "../server/preparation-settings.js";
import { preparationSettingsPath } from "../shared/preparation-settings.js";

test("preparation settings default to eight and reject invalid values and stale versions without writes", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "preparation-settings-"));
  const workspace = await openFixtureWorkspace(root);
  const wake = t.mock.method(
    ApplicationPreparationManager.prototype,
    "wake",
    () => {},
  );
  try {
    const old = workspace.store.settings();
    assert.equal(old.parallelPreparations, undefined);
    assert.equal(parallelPreparations(workspace.store), 8);
    for (const value of [null, "8", 0, 13, 1.5, true, [], {}, undefined]) {
      const response = await workspace.post(preparationSettingsPath, {
        expectedVersion: old.version,
        parallelPreparations: value,
      });
      assert.equal(response.status, 400, String(value));
      assert.match((await response.json()).error, /whole number from 1 to 12/);
      assert.deepEqual(workspace.store.settings(), old);
    }
    for (const expectedVersion of [undefined, "1", -1, 1.5]) {
      const response = await workspace.post(preparationSettingsPath, {
        expectedVersion,
        parallelPreparations: 8,
      });
      assert.equal(response.status, 400);
      assert.deepEqual(workspace.store.settings(), old);
    }
    const conflict = await workspace.post(preparationSettingsPath, {
      expectedVersion: old.version - 1,
      parallelPreparations: 8,
    });
    assert.equal(conflict.status, 409);
    assert.match((await conflict.json()).error, /Settings changed/);
    assert.deepEqual(workspace.store.settings(), old);
    assert.equal(wake.mock.callCount(), 0);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("preparation settings save either bound once, wake the manager and persist in private state and exports", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "preparation-settings-"));
  let workspace = await openFixtureWorkspace(root);
  const wake = t.mock.method(
    ApplicationPreparationManager.prototype,
    "wake",
    () => {},
  );
  try {
    for (const parallelPreparations of [1, 12]) {
      const old = workspace.store.settings();
      const response = await workspace.post(preparationSettingsPath, {
        expectedVersion: old.version,
        parallelPreparations,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        ...old,
        parallelPreparations,
        version: old.version + 1,
      });
      assert.deepEqual(workspace.store.settings(), {
        ...old,
        parallelPreparations,
        version: old.version + 1,
      });
      assert.equal(
        (
          await workspace.post(preparationSettingsPath, {
            expectedVersion: old.version,
            parallelPreparations,
          })
        ).status,
        409,
      );
    }
    assert.equal(wake.mock.callCount(), 2);
    const saved = workspace.store.settings();
    assert.deepEqual(
      workspace.store.personalExport().records.settings[0],
      saved,
    );
    assert.equal(workspace.store.list("application_preparation").length, 0);
    await workspace.close();
    workspace = await openFixtureWorkspace(root);
    assert.equal(parallelPreparations(workspace.store), 12);
    const state = await (await workspace.get("/api/state")).json();
    assert.deepEqual(state.settings, saved);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
});
