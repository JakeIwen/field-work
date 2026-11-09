import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync, strFromU8 } from "fflate";
import { listenOnEphemeralPort } from "./fixtures/ephemeral-port.js";
import { createWorkspace } from "../server/server.js";
import { Store } from "../server/storage.js";

test("model settings API validates choices, preserves other settings, detects stale saves and backs up preferences", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "model-settings-"));
  const dataDir = path.join(root, ".local");
  const { server, port } = await listenOnEphemeralPort();
  const workspace = await createWorkspace({
    root,
    dataDir,
    port,
    watch: false,
    connectAgent: false,
  });
  server.on("request", workspace.app);
  const base = `http://127.0.0.1:${port}`;
  const { csrfToken } = await (await fetch(base + "/api/session")).json();
  const catalog = {
    models: [
      {
        id: "fixture",
        model: "fixture-model",
        displayName: "Fixture model",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { reasoningEffort: "high" },
          { reasoningEffort: "xhigh" },
        ],
      },
    ],
    error: null,
    refreshedAt: new Date().toISOString(),
    refreshing: false,
  };
  workspace.agent.modelCatalogStatus = () => catalog;
  workspace.agent.warmModels = () => new Promise(() => {});
  const post = (
    codexModels: unknown,
    expectedVersion = workspace.store.settings().version,
    token = csrfToken,
    codexEfforts?: unknown,
  ) =>
    fetch(base + "/api/settings/models", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": token },
      body: JSON.stringify({ codexModels, codexEfforts, expectedVersion }),
    });
  try {
    const response = await fetch(base + "/api/agent/models", {
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(
      response.status,
      200,
      "GET returns cached state while warming is pending",
    );
    assert.equal((await response.json()).models[0].model, "fixture-model");
    assert.equal((await post({}, undefined, "incorrect")).status, 403);
    for (const invalid of [
      [],
      { unknown: "fixture-model" },
      { questions: 7 },
      { questions: "invented" },
    ])
      assert.equal((await post(invalid)).status, 400);
    const original = workspace.store.settings();
    assert.equal(
      (
        await post({
          questions: "fixture-model",
          "application-answers": "fixture-model",
        })
      ).status,
      200,
    );
    assert.equal(workspace.store.settings().timezone, original.timezone);
    assert.deepEqual(workspace.store.settings().schedules, original.schedules);
    assert.equal(
      (
        await post(
          workspace.store.settings().codexModels,
          undefined,
          csrfToken,
          { questions: "xhigh" },
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await post(
          workspace.store.settings().codexModels,
          undefined,
          csrfToken,
          { questions: "ultra" },
        )
      ).status,
      400,
    );
    assert.deepEqual(workspace.store.settings().codexEfforts, {
      questions: "xhigh",
    });
    assert.equal((await post({}, original.version)).status, 409);
    const backup = unzipSync(workspace.store.backup());
    const exported = strFromU8(backup["personal-export.json"]);
    assert.ok(exported.includes('"codexModels"'));
    assert.ok(exported.includes('"codexEfforts"'));
    assert.ok(exported.includes('"fixture-model"'));
    catalog.models = [];
    assert.equal(
      (await post({ questions: "fixture-model" })).status,
      200,
      "can preserve an unavailable saved model while editing others",
    );
  } finally {
    await workspace.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  const reopened = new Store(root, dataDir);
  try {
    assert.deepEqual(reopened.settings().codexModels, {
      questions: "fixture-model",
    });
    assert.deepEqual(reopened.settings().codexEfforts, { questions: "xhigh" });
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});
