import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openFixtureWorkspace } from "./fixtures/http-workspace.js";

const rosewood = {
  id: "rosewood-slate",
  name: "Rosewood Slate",
  knobs: { hueNeutral: 360, hueBrand: 240, hueAccent: 70, chroma: 1.15 },
};

async function withWorkspace(
  run: (
    workspace: Awaited<ReturnType<typeof openFixtureWorkspace>>,
  ) => Promise<void>,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "palette-settings-"));
  const workspace = await openFixtureWorkspace(root);
  try {
    await run(workspace);
  } finally {
    await workspace.close();
    rmSync(root, { recursive: true, force: true });
  }
}

const without = (settings: Record<string, unknown>, ...keys: string[]) => {
  const copy = structuredClone(settings);
  for (const key of keys) delete copy[key];
  return copy;
};

test("theme saves and activation use their own revisions without changing general settings", () =>
  withWorkspace(async (workspace) => {
    const before = structuredClone(workspace.store.settings());

    let response = await workspace.post("/api/settings/themes", {
      theme: { ...rosewood, name: "  Rosewood Slate " },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [rosewood], revision: 1 });

    response = await workspace.post("/api/settings/palette", {
      palette: { id: rosewood.id, knobs: rosewood.knobs },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      id: rosewood.id,
      knobs: rosewood.knobs,
      revision: 1,
    });

    const renamed = { ...rosewood, name: "Rosewood" };
    response = await workspace.post("/api/settings/themes", {
      theme: renamed,
    });
    assert.deepEqual(await response.json(), { items: [renamed], revision: 2 });

    const after = workspace.store.settings();
    assert.equal(after.version, before.version);
    assert.deepEqual(
      without(after, "palette", "themes"),
      without(before, "palette", "themes"),
    );
    const state = await (await workspace.get("/api/state")).json();
    assert.deepEqual(state.settings.themes, { items: [renamed], revision: 2 });
    assert.equal(state.settings.palette.id, rosewood.id);

    response = await workspace.post(
      `/api/settings/themes/${rosewood.id}`,
      {},
      "DELETE",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { items: [], revision: 3 });
  }));

test("invalid appearance writes and the legacy route are rejected without changing settings", () =>
  withWorkspace(async (workspace) => {
    const slate = {
      hueNeutral: 250,
      hueBrand: 240,
      hueAccent: 70,
      chroma: 0.9,
    };
    const invalid: {
      path: string;
      body?: unknown;
      method?: string;
      status?: number;
      message?: string;
    }[] = [
      {
        path: "/api/settings/palette",
        body: { palette: { id: "slate", knobs: { ...slate, chroma: 3 } } },
        message: "chroma must be a number from 0 to 2",
      },
      {
        path: "/api/settings/palette",
        body: { palette: { id: "slate", knobs: { ...slate, hueFocus: 70 } } },
        message: "Unknown knob hueFocus",
      },
      {
        path: "/api/settings/palette",
        body: { palette: { id: "violet", knobs: slate } },
        message: "No theme with id violet",
      },
      {
        path: "/api/settings/palette",
        body: { palette: { palette: "plum", overrides: {} } },
      },
      { path: "/api/settings/palette", body: { palette: "plum" } },
      {
        path: "/api/settings/themes",
        body: { theme: { ...rosewood, id: "slate" } },
        message: "Built-in themes can't be changed",
      },
      {
        path: "/api/settings/themes",
        body: { theme: { ...rosewood, name: " " } },
        message: "Theme name is required",
      },
      {
        path: "/api/settings/themes",
        body: { theme: { ...rosewood, id: "Bad Id" } },
      },
      {
        path: "/api/settings/themes/slate",
        method: "DELETE",
        message: "Built-in themes can't be deleted",
      },
      { path: "/api/settings/themes/missing", method: "DELETE", status: 404 },
      {
        path: "/api/settings",
        body: { palette: { id: "slate", knobs: slate } },
        message: "Provide timezone, schedules or fitCriteria",
      },
    ];
    for (const {
      path: route,
      body,
      method,
      status = 400,
      message,
    } of invalid) {
      const before = structuredClone(workspace.store.settings());
      const response = await workspace.post(route, body, method);
      assert.equal(response.status, status, route);
      if (message) assert.equal((await response.json()).error, message);
      assert.deepEqual(workspace.store.settings(), before);
    }
  }));
